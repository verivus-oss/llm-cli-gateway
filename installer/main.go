package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/verivus-oss/llm-cli-gateway/installer/internal/config"
	"github.com/verivus-oss/llm-cli-gateway/installer/internal/process"
	"github.com/verivus-oss/llm-cli-gateway/installer/internal/setupui"
)

var releaseVersion = "dev"

func main() {
	config.GatewayVersion = releaseVersion
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string) error {
	cmd := "doctor"
	if len(args) > 0 {
		cmd = args[0]
	}
	switch cmd {
	case "--version", "-version", "version":
		fmt.Println(releaseVersion)
		return nil
	case "--help", "-help", "/?", "help":
		fmt.Print(helpText())
		return nil
	case "setup":
		cfg, _, err := config.Ensure()
		if err != nil {
			return err
		}
		return printJSON(map[string]any{"ok": true, "app_dir": cfg.AppDir, "next": "Run doctor --json."})
	case "doctor":
		body, err := config.DoctorJSON()
		if err != nil {
			return err
		}
		fmt.Println(string(body))
		return nil
	case "start":
		cfg, token, err := config.Ensure()
		if err != nil {
			return err
		}
		status, err := process.Start(cfg, token)
		if err != nil {
			return err
		}
		return printJSON(map[string]any{"ok": true, "status": status})
	case "stop":
		cfg, err := config.Default()
		if err != nil {
			return err
		}
		return process.Stop(cfg)
	case "status":
		cfg, err := config.Default()
		if err != nil {
			return err
		}
		status, err := process.Current(cfg)
		if err != nil {
			return err
		}
		return printJSON(map[string]any{"ok": true, "status": status})
	case "repair":
		_, _, err := config.Ensure()
		if err != nil {
			return err
		}
		return printJSON(map[string]any{"ok": true, "changed": false, "message": "No repair actions were required."})
	case "public-url":
		return publicURLCommand(args[1:])
	case "chatgpt-url":
		return chatGPTURLCommand(args[1:])
	case "tunnel":
		return tunnelCommand(args[1:])
	case "print-client-config":
		cfg, _, err := config.Ensure()
		if err != nil {
			return err
		}
		if _, _, err := config.EnsureChatGPTNoAuthPath(); err != nil {
			return err
		}
		cfg, err = config.Default()
		if err != nil {
			return err
		}
		if cfg.PublicURL != "" && cfg.ChatGPTConnectorURL == "" {
			if _, err := config.SetChatGPTURLFromPublicURL(cfg.PublicURL); err != nil {
				return err
			}
			cfg, err = config.Default()
			if err != nil {
				return err
			}
		}
		endpoint := "http://" + cfg.HTTPHost + ":" + cfg.HTTPPort + cfg.HTTPPath
		if cfg.PublicURL != "" {
			endpoint = cfg.PublicURL
		}
		return printJSON(map[string]any{
			"ok":                    true,
			"transport":             "streamable_http",
			"url":                   endpoint,
			"local_url":             "http://" + cfg.HTTPHost + ":" + cfg.HTTPPort + cfg.HTTPPath,
			"web_clients_supported": cfg.PublicURL != "" && strings.HasPrefix(cfg.PublicURL, "https://"),
			"chatgpt":               chatGPTConfig(cfg),
			"headers":               map[string]string{"Authorization": "Bearer <redacted>"},
			"notes":                 []string{"Use the ChatGPT URL with Authentication: No Authentication. Use the bearer-protected URL only for clients that support Authorization headers."},
		})
	case "setup-ui":
		return setupui.Listen("127.0.0.1:3340")
	case "install-bundle":
		return installBundle()
	case "upgrade":
		return upgrade()
	case "uninstall":
		return uninstall(args[1:])
	default:
		return fmt.Errorf("unknown command %q", cmd)
	}
}

func helpText() string {
	return `llm-cli-gateway desktop bootstrapper

Usage:
  llm-cli-gateway [command]

Commands:
  setup                Create local config and auth token
  doctor               Print desktop gateway diagnostics as JSON
  start                Start the managed local HTTP gateway
  stop                 Stop the managed local HTTP gateway
  status               Print managed gateway process status
  repair               Verify local installer state
  public-url <url>     Persist the public HTTPS /mcp URL for ChatGPT/web clients
  public-url clear     Clear the persisted public HTTPS URL
  chatgpt-url          Print the ChatGPT connector URL
  chatgpt-url rotate   Rotate the ChatGPT connector URL path
  chatgpt-url clear    Clear the ChatGPT connector URL path
  tunnel start         Start a managed Cloudflare HTTPS tunnel and persist its /mcp URL
  tunnel status        Print managed tunnel status
  tunnel stop          Stop the managed tunnel and clear its persisted URL
  install-bundle       Download and install the pinned gateway bundle
  upgrade              Stop, install latest bundle, and update bootstrapper
  uninstall [--yes]    Remove managed app state; dry-run unless --yes is set
  print-client-config  Print local MCP HTTP client configuration
  setup-ui             Start the local setup UI
  version              Print bootstrapper version

Flags:
  --version            Print bootstrapper version
  --help, /?           Print this help
`
}

func tunnelCommand(args []string) error {
	subcommand := "status"
	if len(args) > 0 {
		subcommand = args[0]
	}
	switch subcommand {
	case "start":
		if _, _, err := config.Ensure(); err != nil {
			return err
		}
		_, pathChanged, err := config.EnsureChatGPTNoAuthPath()
		if err != nil {
			return err
		}
		cfg, token, err := config.Ensure()
		if err != nil {
			return err
		}
		if pathChanged {
			if err := process.Stop(cfg); err != nil {
				return err
			}
		}
		gatewayStatus, err := process.Start(cfg, token)
		if err != nil {
			return err
		}
		tunnelStatus, err := process.StartTunnel(cfg, "cloudflare")
		if err != nil {
			return err
		}
		chatGPTSettings, err := config.SetChatGPTURLFromPublicURL(tunnelStatus.PublicURL)
		if err != nil {
			return err
		}
		return printJSON(map[string]any{
			"ok":      true,
			"gateway": gatewayStatus,
			"tunnel":  tunnelStatus,
			"chatgpt": chatGPTSettingsJSON(chatGPTSettings),
			"next":    "Use chatgpt.url in ChatGPT with Authentication: No Authentication. Run print-client-config to view both connector URLs.",
		})
	case "status":
		cfg, err := config.Default()
		if err != nil {
			return err
		}
		tunnelStatus, err := process.CurrentTunnel(cfg)
		if err != nil {
			return err
		}
		return printJSON(map[string]any{"ok": true, "tunnel": tunnelStatus})
	case "stop":
		cfg, err := config.Default()
		if err != nil {
			return err
		}
		if err := process.StopTunnel(cfg); err != nil {
			return err
		}
		return printJSON(map[string]any{
			"ok":   true,
			"next": "Run doctor --json to confirm web-client endpoint exposure is no longer configured.",
		})
	default:
		return fmt.Errorf("unknown tunnel command %q", subcommand)
	}
}

func publicURLCommand(args []string) error {
	if len(args) == 0 {
		cfg, err := config.Default()
		if err != nil {
			return err
		}
		return printJSON(map[string]any{
			"ok":                true,
			"public_url":        nullableString(cfg.PublicURL),
			"verify_public_url": cfg.VerifyPublicURL,
			"chatgpt":           chatGPTConfig(cfg),
			"next":              "Run public-url <https://host/mcp> to persist a ChatGPT/web-client endpoint, or public-url clear.",
		})
	}
	if args[0] == "clear" {
		if err := config.ClearPublicURL(); err != nil {
			return err
		}
		return printJSON(map[string]any{
			"ok":         true,
			"public_url": nil,
			"next":       "Run stop then start to relaunch the gateway without a public web-client URL.",
		})
	}
	settings, err := config.SetPublicURL(args[0], true)
	if err != nil {
		return err
	}
	chatGPTSettings, err := config.SetChatGPTURLFromPublicURL(settings.PublicURL)
	if err != nil {
		return err
	}
	return printJSON(map[string]any{
		"ok":                true,
		"public_url":        settings.PublicURL,
		"verify_public_url": settings.VerifyPublicURL,
		"chatgpt":           chatGPTSettingsJSON(chatGPTSettings),
		"next":              "Run stop, start, then doctor --json. Use chatgpt.url in ChatGPT with Authentication: No Authentication.",
	})
}

func chatGPTURLCommand(args []string) error {
	if len(args) > 0 {
		switch args[0] {
		case "rotate":
			settings, err := config.RotateChatGPTURL()
			if err != nil {
				return err
			}
			return printJSON(map[string]any{
				"ok":      true,
				"chatgpt": chatGPTSettingsJSON(settings),
				"next":    "Run stop then start, or rerun tunnel start, so the gateway serves the rotated path.",
			})
		case "clear":
			if err := config.ClearChatGPTURL(); err != nil {
				return err
			}
			return printJSON(map[string]any{
				"ok":      true,
				"chatgpt": map[string]any{"url": nil, "auth": "none"},
				"next":    "Run stop then start to relaunch the gateway without the ChatGPT no-auth path.",
			})
		default:
			return fmt.Errorf("unknown chatgpt-url command %q", args[0])
		}
	}
	if _, _, err := config.Ensure(); err != nil {
		return err
	}
	settings, _, err := config.EnsureChatGPTNoAuthPath()
	if err != nil {
		return err
	}
	cfg, err := config.Default()
	if err != nil {
		return err
	}
	if settings.ChatGPTConnectorURL == "" && cfg.PublicURL != "" {
		settings, err = config.SetChatGPTURLFromPublicURL(cfg.PublicURL)
		if err != nil {
			return err
		}
	}
	return printJSON(map[string]any{
		"ok":      true,
		"chatgpt": chatGPTSettingsJSON(settings),
		"next":    "Use chatgpt.url in ChatGPT with Authentication: No Authentication. If url is null, run tunnel start first.",
	})
}

func chatGPTConfig(cfg config.Config) map[string]any {
	return map[string]any{
		"url":  nullableString(cfg.ChatGPTConnectorURL),
		"auth": "none",
		"path": nullableString(cfg.ChatGPTNoAuthPath),
	}
}

func chatGPTSettingsJSON(settings config.Settings) map[string]any {
	return map[string]any{
		"url":  nullableString(settings.ChatGPTConnectorURL),
		"auth": "none",
		"path": nullableString(settings.ChatGPTNoAuthPath),
	}
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func upgrade() error {
	// `upgrade` is idempotent: it stops the gateway (if running), runs the
	// latest verified bundle download path, and updates the desktop
	// bootstrapper when the release includes a newer one. Config and auth token
	// are preserved across upgrades.
	cfg, err := config.Default()
	if err != nil {
		return err
	}
	prevStatus, _ := process.Current(cfg)
	if prevStatus.Running {
		if err := process.Stop(cfg); err != nil {
			return err
		}
	}
	specs, err := latestReleaseSpecs()
	if err != nil {
		return err
	}
	installResult, err := installBundleSpec(specs.Bundle)
	if err != nil {
		return err
	}
	bootstrapperResult := map[string]any{
		"current_version": releaseVersion,
		"latest_version":  specs.Version,
		"updated":         false,
		"reason":          "already_latest",
	}
	if specs.Bootstrapper != nil && shouldUpdateBootstrapper(specs.Version) {
		bootstrapperResult, err = installBootstrapperSpec(*specs.Bootstrapper, cfg)
		if err != nil {
			return err
		}
	}
	return printJSON(map[string]any{
		"ok":                   true,
		"action":               "upgrade",
		"bootstrapper_version": releaseVersion,
		"bundle":               specs.Bundle.Name,
		"bundle_source":        specs.Bundle.Source,
		"bundle_version":       specs.Bundle.Version,
		"bootstrapper_update":  bootstrapperResult,
		"gateway_dir":          installResult["gateway_dir"],
		"sha256":               installResult["sha256"],
		"previously_running":   prevStatus.Running,
		"next":                 upgradeNextAction(bootstrapperResult),
	})
}

func uninstall(extra []string) error {
	// `uninstall` is intentionally explicit: it requires --yes to remove
	// the managed app directory. Without --yes it prints a dry-run summary.
	confirmed := false
	for _, a := range extra {
		if a == "--yes" || a == "-y" {
			confirmed = true
		}
	}
	cfg, err := config.Default()
	if err != nil {
		return err
	}
	_, statErr := os.Stat(cfg.AppDir)
	if os.IsNotExist(statErr) {
		return printJSON(map[string]any{
			"ok":      true,
			"action":  "uninstall",
			"removed": false,
			"note":    "App directory already absent; nothing to remove.",
		})
	}
	if status, _ := process.Current(cfg); status.Running {
		if err := process.Stop(cfg); err != nil {
			return err
		}
	}
	if !confirmed {
		return printJSON(map[string]any{
			"ok":      true,
			"action":  "uninstall",
			"removed": false,
			"app_dir": cfg.AppDir,
			"note":    "Dry run. Rerun with --yes to delete the app directory and auth token.",
		})
	}
	if err := os.RemoveAll(cfg.AppDir); err != nil {
		return err
	}
	return printJSON(map[string]any{
		"ok":      true,
		"action":  "uninstall",
		"removed": true,
		"app_dir": cfg.AppDir,
	})
}

func installBundle() error {
	spec, err := bundleSpecFromEnv()
	if err != nil {
		return err
	}
	if spec.URL == "" {
		spec, err = latestBundleSpec()
		if err != nil {
			return err
		}
	}
	result, err := installBundleSpec(spec)
	if err != nil {
		return err
	}
	return printJSON(result)
}

type bundleSpec struct {
	URL     string
	SHA256  string
	Name    string
	Version string
	Source  string
}

type bootstrapperSpec struct {
	URL     string
	SHA256  string
	Name    string
	Version string
	Source  string
}

type releaseSpecs struct {
	Version      string
	Bundle       bundleSpec
	Bootstrapper *bootstrapperSpec
}

func bundleSpecFromEnv() (bundleSpec, error) {
	rawURL := strings.TrimSpace(os.Getenv("RVWR_GATEWAY_BUNDLE_URL"))
	rawSHA := strings.TrimSpace(os.Getenv("RVWR_GATEWAY_BUNDLE_SHA256"))
	if rawURL == "" && rawSHA == "" {
		return bundleSpec{}, nil
	}
	if rawURL == "" || rawSHA == "" {
		return bundleSpec{}, errors.New("set both RVWR_GATEWAY_BUNDLE_URL and RVWR_GATEWAY_BUNDLE_SHA256, or unset both to use the latest GitHub release")
	}
	return bundleSpec{
		URL:    rawURL,
		SHA256: rawSHA,
		Name:   filepath.Base(rawURL),
		Source: "env",
	}, nil
}

func installBundleSpec(spec bundleSpec) (map[string]any, error) {
	cfg, _, err := config.Ensure()
	if err != nil {
		return nil, err
	}
	tmp := filepath.Join(cfg.AppDir, "gateway-bundle.tmp")
	gotSHA, err := downloadVerifiedFile(spec.URL, spec.SHA256, tmp, "bundle")
	if err != nil {
		return nil, err
	}
	installedRoot, err := installVerifiedBundle(tmp, cfg)
	_ = os.Remove(tmp)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"ok":             true,
		"gateway_dir":    installedRoot,
		"sha256":         gotSHA,
		"bundle":         spec.Name,
		"bundle_source":  spec.Source,
		"bundle_version": spec.Version,
	}, nil
}

func installBootstrapperSpec(spec bootstrapperSpec, cfg config.Config) (map[string]any, error) {
	exePath, err := os.Executable()
	if err != nil {
		return nil, err
	}
	exePath, err = filepath.EvalSymlinks(exePath)
	if err != nil {
		return nil, err
	}
	tmp := exePath + ".new"
	gotSHA, err := downloadVerifiedFile(spec.URL, spec.SHA256, tmp, "bootstrapper")
	if err != nil {
		return nil, err
	}
	if runtime.GOOS == "windows" {
		scriptPath, err := writeWindowsSelfReplaceScript(cfg, exePath, tmp)
		if err != nil {
			_ = os.Remove(tmp)
			return nil, err
		}
		if err := startWindowsSelfReplace(scriptPath); err != nil {
			_ = os.Remove(tmp)
			return nil, err
		}
		return map[string]any{
			"current_version": releaseVersion,
			"latest_version":  spec.Version,
			"updated":         false,
			"pending":         true,
			"path":            exePath,
			"sha256":          gotSHA,
			"note":            "Bootstrapper replacement is staged and will complete after this command exits.",
		}, nil
	}
	if err := os.Chmod(tmp, 0o755); err != nil {
		_ = os.Remove(tmp)
		return nil, err
	}
	if err := os.Rename(tmp, exePath); err != nil {
		_ = os.Remove(tmp)
		return nil, err
	}
	return map[string]any{
		"current_version": releaseVersion,
		"latest_version":  spec.Version,
		"updated":         true,
		"path":            exePath,
		"sha256":          gotSHA,
	}, nil
}

func downloadVerifiedFile(rawURL, expectedSHA, dstPath, label string) (string, error) {
	file, err := os.Create(dstPath)
	if err != nil {
		return "", err
	}
	hasher := sha256.New()
	if err := downloadBundle(rawURL, io.MultiWriter(file, hasher)); err != nil {
		_ = file.Close()
		_ = os.Remove(dstPath)
		return "", err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(dstPath)
		return "", err
	}
	gotSHA := hex.EncodeToString(hasher.Sum(nil))
	if !strings.EqualFold(gotSHA, expectedSHA) {
		_ = os.Remove(dstPath)
		return "", fmt.Errorf("%s checksum mismatch for %s: expected %s, got %s", label, rawURL, expectedSHA, gotSHA)
	}
	return gotSHA, nil
}

func downloadBundle(rawURL string, dst io.Writer) error {
	parsed, err := url.Parse(rawURL)
	if err == nil && parsed.Scheme == "file" {
		source, err := os.Open(parsed.Path)
		if err != nil {
			return err
		}
		defer source.Close()
		_, err = io.Copy(dst, source)
		return err
	}
	resp, err := http.Get(rawURL)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("bundle download failed: %s", resp.Status)
	}
	_, err = io.Copy(dst, resp.Body)
	return err
}

type githubRelease struct {
	TagName string `json:"tag_name"`
	Assets  []struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
	} `json:"assets"`
}

func latestBundleSpec() (bundleSpec, error) {
	specs, err := latestReleaseSpecs()
	if err != nil {
		return bundleSpec{}, err
	}
	return specs.Bundle, nil
}

func latestReleaseSpecs() (releaseSpecs, error) {
	releaseURL := os.Getenv("RVWR_RELEASE_API_URL")
	if releaseURL == "" {
		releaseURL = "https://api.github.com/repos/verivus-oss/llm-cli-gateway/releases/latest"
	}

	body, err := getURL(releaseURL)
	if err != nil {
		return releaseSpecs{}, err
	}
	var release githubRelease
	if err := json.Unmarshal(body, &release); err != nil {
		return releaseSpecs{}, fmt.Errorf("parse latest release metadata: %w", err)
	}
	version := strings.TrimPrefix(release.TagName, "v")
	if version == "" {
		return releaseSpecs{}, errors.New("latest release metadata did not include tag_name")
	}

	bundleName := fmt.Sprintf("llm-cli-gateway-bundle-%s-%s-%s.tar.gz", version, runtime.GOOS, runtime.GOARCH)
	bundleURL, ok := releaseAssetURL(release, bundleName)
	if !ok {
		return releaseSpecs{}, fmt.Errorf("latest release %s does not include %s", release.TagName, bundleName)
	}
	checksumsURL, ok := releaseAssetURL(release, "SHA256SUMS")
	if !ok {
		return releaseSpecs{}, fmt.Errorf("latest release %s does not include SHA256SUMS", release.TagName)
	}

	checksums, err := getURL(checksumsURL)
	if err != nil {
		return releaseSpecs{}, err
	}
	sha, err := shaFromChecksums(string(checksums), bundleName)
	if err != nil {
		return releaseSpecs{}, err
	}
	specs := releaseSpecs{
		Version: version,
		Bundle: bundleSpec{
			URL:     bundleURL,
			SHA256:  sha,
			Name:    bundleName,
			Version: version,
			Source:  "github-latest",
		},
	}
	bootstrapperName := bootstrapperAssetName(version)
	if bootstrapperURL, ok := releaseAssetURL(release, bootstrapperName); ok {
		bootstrapperSHA, err := shaFromChecksums(string(checksums), bootstrapperName)
		if err != nil {
			return releaseSpecs{}, err
		}
		specs.Bootstrapper = &bootstrapperSpec{
			URL:     bootstrapperURL,
			SHA256:  bootstrapperSHA,
			Name:    bootstrapperName,
			Version: version,
			Source:  "github-latest",
		}
	}
	return specs, nil
}

func bootstrapperAssetName(version string) string {
	name := fmt.Sprintf("llm-cli-gateway-%s-%s-%s", version, runtime.GOOS, runtime.GOARCH)
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return name
}

func shouldUpdateBootstrapper(latestVersion string) bool {
	return releaseVersion != "dev" && latestVersion != "" && latestVersion != releaseVersion
}

func upgradeNextAction(bootstrapperResult map[string]any) string {
	if pending, _ := bootstrapperResult["pending"].(bool); pending {
		return "Wait a moment for the bootstrapper replacement to complete, then run start."
	}
	return "Run start to relaunch the gateway with the upgraded bundle."
}

func writeWindowsSelfReplaceScript(cfg config.Config, exePath, tmpPath string) (string, error) {
	if err := os.MkdirAll(cfg.AppDir, 0o700); err != nil {
		return "", err
	}
	scriptPath := filepath.Join(cfg.AppDir, "replace-bootstrapper.ps1")
	script := fmt.Sprintf(`$ErrorActionPreference = "Stop"
$ParentPid = %d
$Source = %s
$Destination = %s
for ($i = 0; $i -lt 120; $i++) {
  try {
    $process = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
    if ($process) {
      Wait-Process -Id $ParentPid -Timeout 1 -ErrorAction SilentlyContinue
    }
  } catch {}
  try {
    Move-Item -LiteralPath $Source -Destination $Destination -Force
    Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue
    exit 0
  } catch {
    Start-Sleep -Milliseconds 500
  }
}
exit 1
`, os.Getpid(), powershellSingleQuoted(tmpPath), powershellSingleQuoted(exePath))
	if err := os.WriteFile(scriptPath, []byte(script), 0o600); err != nil {
		return "", err
	}
	return scriptPath, nil
}

func startWindowsSelfReplace(scriptPath string) error {
	cmd := exec.Command("powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath)
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

func powershellSingleQuoted(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func releaseAssetURL(release githubRelease, name string) (string, bool) {
	for _, asset := range release.Assets {
		if asset.Name == name && asset.BrowserDownloadURL != "" {
			return asset.BrowserDownloadURL, true
		}
	}
	return "", false
}

func shaFromChecksums(checksums, name string) (string, error) {
	for _, line := range strings.Split(checksums, "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[1] == name {
			return strings.ToLower(fields[0]), nil
		}
	}
	return "", fmt.Errorf("SHA256SUMS does not include %s", name)
}

func getURL(rawURL string) ([]byte, error) {
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "llm-cli-gateway-bootstrapper/"+releaseVersion)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, fmt.Errorf("download failed for %s: %s", rawURL, resp.Status)
	}
	return io.ReadAll(resp.Body)
}

func installVerifiedBundle(bundlePath string, cfg config.Config) (string, error) {
	staging := filepath.Join(cfg.AppDir, "gateway-install.tmp")
	if err := os.RemoveAll(staging); err != nil {
		return "", err
	}
	if err := os.MkdirAll(staging, 0o700); err != nil {
		return "", err
	}
	defer os.RemoveAll(staging)

	if err := extractBundle(bundlePath, staging); err != nil {
		return "", err
	}
	root, err := findGatewayRoot(staging)
	if err != nil {
		return "", err
	}
	runtimeRoot, err := findRuntimeRoot(staging)
	if err != nil {
		if os.Getenv("RVWR_ALLOW_HOST_NODE") != "1" {
			return "", err
		}
	}
	swaps := []dirSwap{{source: root, destination: cfg.GatewayDir}}
	if runtimeRoot != "" {
		swaps = append(swaps, dirSwap{source: runtimeRoot, destination: cfg.RuntimeDir})
	}
	if err := replaceDirs(swaps); err != nil {
		return "", err
	}
	return cfg.GatewayDir, nil
}

func extractBundle(bundlePath, dst string) error {
	if strings.HasSuffix(bundlePath, ".zip") {
		return extractZip(bundlePath, dst)
	}
	if err := extractTarGzip(bundlePath, dst); err == nil {
		return nil
	}
	return extractZip(bundlePath, dst)
}

func extractTarGzip(bundlePath, dst string) error {
	file, err := os.Open(bundlePath)
	if err != nil {
		return err
	}
	defer file.Close()
	gz, err := gzip.NewReader(file)
	if err != nil {
		return err
	}
	defer gz.Close()
	reader := tar.NewReader(gz)
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		target, err := safeJoin(dst, header.Name)
		if err != nil {
			return err
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o700); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
				return err
			}
			if err := writeFileFromReader(target, reader, os.FileMode(header.Mode)); err != nil {
				return err
			}
		}
	}
}

func extractZip(bundlePath, dst string) error {
	reader, err := zip.OpenReader(bundlePath)
	if err != nil {
		return err
	}
	defer reader.Close()
	for _, entry := range reader.File {
		target, err := safeJoin(dst, entry.Name)
		if err != nil {
			return err
		}
		if entry.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o700); err != nil {
				return err
			}
			continue
		}
		source, err := entry.Open()
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			_ = source.Close()
			return err
		}
		err = writeFileFromReader(target, source, entry.Mode())
		_ = source.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

func writeFileFromReader(path string, reader io.Reader, mode os.FileMode) error {
	if mode == 0 {
		mode = 0o600
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode&0o777)
	if err != nil {
		return err
	}
	if _, err := io.Copy(file, reader); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}

func safeJoin(root, name string) (string, error) {
	cleaned := filepath.Clean(name)
	if filepath.IsAbs(cleaned) || cleaned == ".." || strings.HasPrefix(cleaned, ".."+string(os.PathSeparator)) {
		return "", fmt.Errorf("unsafe bundle path %q", name)
	}
	target := filepath.Join(root, cleaned)
	rel, err := filepath.Rel(root, target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return "", fmt.Errorf("unsafe bundle path %q", name)
	}
	return target, nil
}

func findGatewayRoot(staging string) (string, error) {
	var found string
	err := filepath.WalkDir(staging, func(path string, entry os.DirEntry, err error) error {
		if err != nil || found != "" || !entry.IsDir() {
			return err
		}
		if _, statErr := os.Stat(filepath.Join(path, "dist", "index.js")); statErr == nil {
			found = path
			return filepath.SkipDir
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	if found == "" {
		return "", errors.New("verified bundle missing dist/index.js")
	}
	return found, nil
}

func findRuntimeRoot(staging string) (string, error) {
	exe := runtimeNodeExecutableName()
	var found string
	err := filepath.WalkDir(staging, func(path string, entry os.DirEntry, err error) error {
		if err != nil || found != "" || !entry.IsDir() {
			return err
		}
		if _, markerErr := os.Stat(filepath.Join(path, ".llm-cli-gateway-runtime")); markerErr != nil {
			return nil
		}
		if _, statErr := os.Stat(filepath.Join(path, exe)); statErr == nil {
			found = path
			return filepath.SkipDir
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	if found == "" {
		return "", errors.New("verified bundle missing managed Node runtime")
	}
	return found, nil
}

func runtimeNodeExecutableName() string {
	if strings.EqualFold(os.Getenv("OS"), "Windows_NT") {
		return "node.exe"
	}
	if filepath.Separator == '\\' {
		return "node.exe"
	}
	return "node"
}

type dirSwap struct {
	source      string
	destination string
}

func replaceDirs(swaps []dirSwap) error {
	prepared := make([]dirSwap, 0, len(swaps))
	applied := make([]dirSwap, 0, len(swaps))
	for _, swap := range swaps {
		previous := swap.destination + ".previous"
		if err := os.RemoveAll(previous); err != nil {
			return err
		}
		if _, err := os.Stat(swap.destination); err == nil {
			if err := os.Rename(swap.destination, previous); err != nil {
				rollbackDirs(prepared, applied)
				return err
			}
		}
		prepared = append(prepared, swap)
	}

	for _, swap := range swaps {
		if err := os.Rename(swap.source, swap.destination); err != nil {
			rollbackDirs(prepared, applied)
			return err
		}
		applied = append(applied, swap)
	}

	for _, swap := range swaps {
		if err := os.RemoveAll(swap.destination + ".previous"); err != nil {
			return err
		}
	}
	return nil
}

func rollbackDirs(prepared, applied []dirSwap) {
	for i := len(applied) - 1; i >= 0; i-- {
		_ = os.RemoveAll(applied[i].destination)
	}
	for i := len(prepared) - 1; i >= 0; i-- {
		previous := prepared[i].destination + ".previous"
		if _, err := os.Stat(previous); err == nil {
			_ = os.Rename(previous, prepared[i].destination)
		}
	}
}

func printJSON(value any) error {
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(encoded))
	return nil
}
