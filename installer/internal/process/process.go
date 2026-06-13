package process

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/verivus-oss/llm-cli-gateway/installer/internal/config"
)

type Status struct {
	Running bool   `json:"running"`
	PID     int    `json:"pid,omitempty"`
	URL     string `json:"url,omitempty"`
	LogPath string `json:"log_path,omitempty"`
}

type TunnelStatus struct {
	Running   bool   `json:"running"`
	PID       int    `json:"pid,omitempty"`
	Provider  string `json:"provider,omitempty"`
	PublicURL string `json:"public_url,omitempty"`
	LocalURL  string `json:"local_url,omitempty"`
	LogPath   string `json:"log_path,omitempty"`
}

type tunnelMetadata struct {
	Provider  string `json:"provider,omitempty"`
	PublicURL string `json:"public_url,omitempty"`
}

var tunnelURLPattern = regexp.MustCompile(`https://[A-Za-z0-9.-]+\.trycloudflare\.com`)

func Start(cfg config.Config, token string) (status Status, err error) {
	if status, _ := Current(cfg); status.Running {
		return status, nil
	}
	entry := filepath.Join(cfg.GatewayDir, "dist", "index.js")
	if _, err := os.Stat(entry); err != nil {
		return Status{}, errors.New("gateway bundle missing; install a verified bundle before start")
	}
	logPath := filepath.Join(cfg.AppDir, "gateway.log")
	errPath := filepath.Join(cfg.AppDir, "gateway.err.log")
	// #nosec G304 -- logPath is built from the installer-owned AppDir, not user input.
	stdout, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return Status{}, err
	}
	defer closeAndJoinError(stdout, &err)
	// #nosec G304 -- errPath is built from the installer-owned AppDir, not user input.
	stderr, err := os.OpenFile(errPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return Status{}, err
	}
	defer closeAndJoinError(stderr, &err)
	nodePath := cfg.RuntimeNode
	if _, err := os.Stat(nodePath); err != nil {
		if os.Getenv("RVWR_ALLOW_HOST_NODE") != "1" {
			return Status{}, errors.New("managed Node runtime missing; install the verified platform bundle before start")
		}
		nodePath = "node"
	}
	// #nosec G204 -- argv array, no shell: managed Node runtime + bundled gateway script + literal flag.
	cmd := exec.Command(nodePath, entry, "--transport=http")
	cmd.Env = config.EnvForGateway(cfg, token)
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	configureHiddenProcess(cmd)
	if err := cmd.Start(); err != nil {
		return Status{}, err
	}
	if err := os.WriteFile(pidPath(cfg), []byte(strconv.Itoa(cmd.Process.Pid)), 0o600); err != nil {
		return Status{}, err
	}
	done := make(chan error, 1)
	go func() {
		done <- cmd.Wait()
		_ = os.Remove(pidPath(cfg))
	}()
	url := "http://" + cfg.HTTPHost + ":" + cfg.HTTPPort + "/healthz"
	if err := waitForHTTPReady(url, done, errPath, 10*time.Second); err != nil {
		return Status{}, err
	}
	return Status{Running: true, PID: cmd.Process.Pid, URL: "http://" + cfg.HTTPHost + ":" + cfg.HTTPPort + cfg.HTTPPath, LogPath: logPath}, nil
}

func closeAndJoinError(file *os.File, errp *error) {
	if file == nil {
		return
	}
	if closeErr := file.Close(); closeErr != nil {
		*errp = errors.Join(*errp, closeErr)
	}
}

func StartTunnel(cfg config.Config, provider string) (TunnelStatus, error) {
	if provider == "" {
		provider = "cloudflare"
	}
	if provider != "cloudflare" {
		return TunnelStatus{}, fmt.Errorf("unsupported tunnel provider %q; supported provider: cloudflare", provider)
	}
	if status, _ := CurrentTunnel(cfg); status.Running {
		return status, nil
	}
	cloudflared, err := cloudflaredExecutable()
	if err != nil {
		return TunnelStatus{}, err
	}
	localURL := "http://" + cfg.HTTPHost + ":" + cfg.HTTPPort
	if err := os.MkdirAll(cfg.AppDir, 0o700); err != nil {
		return TunnelStatus{}, err
	}
	logPath := tunnelLogPath(cfg)
	// #nosec G304 -- tunnel logPath is built from the installer-owned AppDir, not user input.
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return TunnelStatus{}, err
	}

	// #nosec G204 -- argv array, no shell: cloudflared is a resolved executable path, args are literals + an internally-built local URL.
	cmd := exec.Command(cloudflared, "tunnel", "--no-autoupdate", "--url", localURL)
	configureHiddenProcess(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = logFile.Close()
		return TunnelStatus{}, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = logFile.Close()
		return TunnelStatus{}, err
	}

	foundURL := make(chan string, 2)
	go scanTunnelOutput(stdout, logFile, foundURL)
	go scanTunnelOutput(stderr, logFile, foundURL)

	if err := cmd.Start(); err != nil {
		_ = logFile.Close()
		return TunnelStatus{}, err
	}
	if err := os.WriteFile(tunnelPIDPath(cfg), []byte(strconv.Itoa(cmd.Process.Pid)), 0o600); err != nil {
		_ = cmd.Process.Kill()
		_ = logFile.Close()
		return TunnelStatus{}, err
	}

	done := make(chan error, 1)
	go func() {
		done <- cmd.Wait()
		_ = logFile.Close()
		_ = os.Remove(tunnelPIDPath(cfg))
	}()

	var publicURL string
	select {
	case rawURL := <-foundURL:
		settings, err := config.SetPublicURL(rawURL, true)
		if err != nil {
			_ = cmd.Process.Kill()
			return TunnelStatus{}, err
		}
		publicURL = settings.PublicURL
		if err := writeTunnelMetadata(cfg, tunnelMetadata{Provider: provider, PublicURL: publicURL}); err != nil {
			_ = cmd.Process.Kill()
			return TunnelStatus{}, err
		}
	case err := <-done:
		_ = os.Remove(tunnelPIDPath(cfg))
		if err == nil {
			return TunnelStatus{}, fmt.Errorf("tunnel exited before printing a public URL; log: %s", logPath)
		}
		return TunnelStatus{}, fmt.Errorf("tunnel exited before printing a public URL: %w; log: %s", err, logPath)
	case <-time.After(30 * time.Second):
		_ = cmd.Process.Kill()
		_ = os.Remove(tunnelPIDPath(cfg))
		return TunnelStatus{}, fmt.Errorf("tunnel did not print a public HTTPS URL within 30s; log: %s", logPath)
	}

	return TunnelStatus{
		Running:   true,
		PID:       cmd.Process.Pid,
		Provider:  provider,
		PublicURL: publicURL,
		LocalURL:  localURL,
		LogPath:   logPath,
	}, nil
}

func Stop(cfg config.Config) error {
	pid, err := readPID(cfg)
	if err != nil {
		_ = os.Remove(pidPath(cfg))
		return nil
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		_ = os.Remove(pidPath(cfg))
		return nil
	}
	if err := process.Signal(syscall.SIGTERM); err != nil {
		_ = process.Kill()
	}
	if !waitForHTTPStopped(cfg, 2*time.Second) {
		_ = process.Kill()
		waitForHTTPStopped(cfg, 5*time.Second)
	}
	_ = os.Remove(pidPath(cfg))
	return nil
}

func StopTunnel(cfg config.Config) error {
	metadata := readTunnelMetadata(cfg)
	pid, err := readTunnelPID(cfg)
	if err == nil {
		process, findErr := os.FindProcess(pid)
		if findErr == nil {
			if err := process.Signal(syscall.SIGTERM); err != nil {
				_ = process.Kill()
			}
			if !waitForProcessStopped(pid, 2*time.Second) {
				_ = process.Kill()
				waitForProcessStopped(pid, 5*time.Second)
			}
		}
	}
	_ = os.Remove(tunnelPIDPath(cfg))
	_ = os.Remove(tunnelMetadataPath(cfg))
	currentPublicURL := cfg.PublicURL
	if latestCfg, err := config.Default(); err == nil && latestCfg.PublicURL != "" {
		currentPublicURL = latestCfg.PublicURL
	}
	if metadata.PublicURL != "" && currentPublicURL == metadata.PublicURL {
		_ = config.ClearPublicURL()
	}
	return nil
}

func Current(cfg config.Config) (Status, error) {
	pid, err := readPID(cfg)
	if err != nil {
		return Status{Running: false}, nil
	}
	if processIsRunning(pid) {
		return runningStatus(cfg, pid), nil
	}
	if healthzReady(cfg) {
		return runningStatus(cfg, pid), nil
	}
	return Status{Running: false, PID: pid}, nil
}

func CurrentTunnel(cfg config.Config) (TunnelStatus, error) {
	metadata := readTunnelMetadata(cfg)
	pid, err := readTunnelPID(cfg)
	if err != nil {
		return TunnelStatus{Running: false, Provider: metadata.Provider, PublicURL: metadata.PublicURL}, nil
	}
	if processIsRunning(pid) {
		return TunnelStatus{
			Running:   true,
			PID:       pid,
			Provider:  metadata.Provider,
			PublicURL: metadata.PublicURL,
			LocalURL:  "http://" + cfg.HTTPHost + ":" + cfg.HTTPPort,
			LogPath:   tunnelLogPath(cfg),
		}, nil
	}
	_ = os.Remove(tunnelPIDPath(cfg))
	return TunnelStatus{Running: false, PID: pid, Provider: metadata.Provider, PublicURL: metadata.PublicURL, LogPath: tunnelLogPath(cfg)}, nil
}

func pidPath(cfg config.Config) string {
	return filepath.Join(cfg.AppDir, "gateway.pid")
}

func tunnelPIDPath(cfg config.Config) string {
	return filepath.Join(cfg.AppDir, "tunnel.pid")
}

func tunnelLogPath(cfg config.Config) string {
	return filepath.Join(cfg.AppDir, "tunnel.log")
}

func tunnelMetadataPath(cfg config.Config) string {
	return filepath.Join(cfg.AppDir, "tunnel.json")
}

func readPID(cfg config.Config) (int, error) {
	raw, err := os.ReadFile(pidPath(cfg))
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(string(raw)))
}

func readTunnelPID(cfg config.Config) (int, error) {
	raw, err := os.ReadFile(tunnelPIDPath(cfg))
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(string(raw)))
}

func runningStatus(cfg config.Config, pid int) Status {
	return Status{
		Running: true,
		PID:     pid,
		URL:     "http://" + cfg.HTTPHost + ":" + cfg.HTTPPort + cfg.HTTPPath,
		LogPath: filepath.Join(cfg.AppDir, "gateway.log"),
	}
}

func processIsRunning(pid int) bool {
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	if runtime.GOOS == "windows" {
		return windowsProcessIsRunning(pid)
	}
	return process.Signal(syscall.Signal(0)) == nil
}

func windowsProcessIsRunning(pid int) bool {
	// #nosec G204 -- argv array, no shell: fixed "tasklist" with an integer PID formatted into a literal filter; no injectable input.
	cmd := exec.Command("tasklist", "/FI", fmt.Sprintf("PID eq %d", pid), "/FO", "CSV", "/NH")
	configureHiddenProcess(cmd)
	output, err := cmd.Output()
	if err != nil {
		return false
	}
	return strings.Contains(string(output), fmt.Sprintf("\"%d\"", pid))
}

func waitForProcessStopped(pid int, timeout time.Duration) bool {
	deadline := time.After(timeout)
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-deadline:
			return false
		case <-ticker.C:
			if !processIsRunning(pid) {
				return true
			}
		}
	}
}

func healthzReady(cfg config.Config) bool {
	client := http.Client{Timeout: 500 * time.Millisecond}
	resp, err := client.Get("http://" + cfg.HTTPHost + ":" + cfg.HTTPPort + "/healthz")
	if err != nil {
		return false
	}
	_ = resp.Body.Close()
	return resp.StatusCode >= 200 && resp.StatusCode < 500
}

func waitForHTTPStopped(cfg config.Config, timeout time.Duration) bool {
	deadline := time.After(timeout)
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-deadline:
			return false
		case <-ticker.C:
			if !healthzReady(cfg) {
				return true
			}
		}
	}
}

func cloudflaredExecutable() (string, error) {
	if configured := strings.TrimSpace(os.Getenv("LLM_GATEWAY_CLOUDFLARED_PATH")); configured != "" {
		// #nosec G703 -- operator-supplied path to their own cloudflared binary (LLM_GATEWAY_CLOUDFLARED_PATH); a stat of an explicitly configured tool on the operator's own machine, not an untrusted traversal sink.
		if _, err := os.Stat(configured); err != nil {
			return "", fmt.Errorf("LLM_GATEWAY_CLOUDFLARED_PATH points to an unavailable file: %w", err)
		}
		return configured, nil
	}
	path, err := exec.LookPath("cloudflared")
	if err != nil {
		return "", errors.New(cloudflaredInstallMessage())
	}
	return path, nil
}

func cloudflaredInstallMessage() string {
	if runtime.GOOS == "windows" {
		return "cloudflared not found on PATH; install it with `winget install --id Cloudflare.cloudflared --exact`, then rerun `llm-cli-gateway tunnel start`, or set LLM_GATEWAY_CLOUDFLARED_PATH to cloudflared.exe"
	}
	if runtime.GOOS == "darwin" {
		return "cloudflared not found on PATH; install it with `brew install cloudflared`, then rerun `llm-cli-gateway tunnel start`, or set LLM_GATEWAY_CLOUDFLARED_PATH"
	}
	return "cloudflared not found on PATH; install Cloudflare Tunnel through your OS package manager, then rerun `llm-cli-gateway tunnel start`, or set LLM_GATEWAY_CLOUDFLARED_PATH"
}

func scanTunnelOutput(reader io.Reader, log io.Writer, foundURL chan<- string) {
	scanner := bufio.NewScanner(reader)
	for scanner.Scan() {
		line := scanner.Text()
		_, _ = fmt.Fprintln(log, line)
		if match := tunnelURLPattern.FindString(line); match != "" {
			select {
			case foundURL <- match:
			default:
			}
		}
	}
}

func readTunnelMetadata(cfg config.Config) tunnelMetadata {
	body, err := os.ReadFile(tunnelMetadataPath(cfg))
	if err != nil {
		return tunnelMetadata{}
	}
	var metadata tunnelMetadata
	if err := json.Unmarshal(body, &metadata); err != nil {
		return tunnelMetadata{}
	}
	return metadata
}

func writeTunnelMetadata(cfg config.Config, metadata tunnelMetadata) error {
	if err := os.MkdirAll(cfg.AppDir, 0o700); err != nil {
		return err
	}
	body, err := json.MarshalIndent(metadata, "", "  ")
	if err != nil {
		return err
	}
	body = append(body, '\n')
	return os.WriteFile(tunnelMetadataPath(cfg), body, 0o600)
}

func waitForHTTPReady(url string, done <-chan error, errPath string, timeout time.Duration) error {
	client := http.Client{Timeout: 500 * time.Millisecond}
	deadline := time.After(timeout)
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case err := <-done:
			if err == nil {
				return fmt.Errorf("gateway exited before becoming ready; stderr log: %s", errPath)
			}
			return fmt.Errorf("gateway exited before becoming ready: %w; stderr log: %s", err, errPath)
		case <-deadline:
			return fmt.Errorf("gateway did not become ready at %s within %s; stderr log: %s", url, timeout, errPath)
		case <-ticker.C:
			resp, err := client.Get(url)
			if err == nil {
				_ = resp.Body.Close()
				if resp.StatusCode >= 200 && resp.StatusCode < 500 {
					return nil
				}
			}
		}
	}
}
