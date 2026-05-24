package process

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
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

func Start(cfg config.Config, token string) (Status, error) {
	if status, _ := Current(cfg); status.Running {
		return status, nil
	}
	entry := filepath.Join(cfg.GatewayDir, "dist", "index.js")
	if _, err := os.Stat(entry); err != nil {
		return Status{}, errors.New("gateway bundle missing; install a verified bundle before start")
	}
	logPath := filepath.Join(cfg.AppDir, "gateway.log")
	errPath := filepath.Join(cfg.AppDir, "gateway.err.log")
	stdout, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return Status{}, err
	}
	defer stdout.Close()
	stderr, err := os.OpenFile(errPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return Status{}, err
	}
	defer stderr.Close()
	nodePath := cfg.RuntimeNode
	if _, err := os.Stat(nodePath); err != nil {
		if os.Getenv("RVWR_ALLOW_HOST_NODE") != "1" {
			return Status{}, errors.New("managed Node runtime missing; install the verified platform bundle before start")
		}
		nodePath = "node"
	}
	cmd := exec.Command(nodePath, entry, "--transport=http")
	cmd.Env = config.EnvForGateway(cfg, token)
	cmd.Stdout = stdout
	cmd.Stderr = stderr
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

func pidPath(cfg config.Config) string {
	return filepath.Join(cfg.AppDir, "gateway.pid")
}

func readPID(cfg config.Config) (int, error) {
	raw, err := os.ReadFile(pidPath(cfg))
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
	output, err := exec.Command("tasklist", "/FI", fmt.Sprintf("PID eq %d", pid), "/FO", "CSV", "/NH").Output()
	if err != nil {
		return false
	}
	return strings.Contains(string(output), fmt.Sprintf("\"%d\"", pid))
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
