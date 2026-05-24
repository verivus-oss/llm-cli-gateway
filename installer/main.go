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
	case "print-client-config":
		cfg, _, err := config.Ensure()
		if err != nil {
			return err
		}
		return printJSON(map[string]any{
			"ok":        true,
			"transport": "streamable_http",
			"url":       "http://" + cfg.HTTPHost + ":" + cfg.HTTPPort + cfg.HTTPPath,
			"headers":   map[string]string{"Authorization": "Bearer <redacted>"},
			"notes":     []string{"Read the bearer token from the local auth-token file; do not paste it into remote chat."},
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
  install-bundle       Download and install the pinned gateway bundle
  upgrade              Stop, install the pinned bundle, and leave gateway stopped
  uninstall [--yes]    Remove managed app state; dry-run unless --yes is set
  print-client-config  Print local MCP HTTP client configuration
  setup-ui             Start the local setup UI
  version              Print bootstrapper version

Flags:
  --version            Print bootstrapper version
  --help, /?           Print this help
`
}

func upgrade() error {
	// `upgrade` is idempotent: it stops the gateway (if running), runs the
	// latest verified bundle download path, then leaves the bootstrapper for
	// the user to `start` again. Config and auth token are preserved across
	// upgrades.
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
	spec, err := latestBundleSpec()
	if err != nil {
		return err
	}
	installResult, err := installBundleSpec(spec)
	if err != nil {
		return err
	}
	return printJSON(map[string]any{
		"ok":                 true,
		"action":             "upgrade",
		"bundle":             spec.Name,
		"bundle_source":      spec.Source,
		"bundle_version":     spec.Version,
		"gateway_dir":        installResult["gateway_dir"],
		"sha256":             installResult["sha256"],
		"previously_running": prevStatus.Running,
		"next":               "Run start to relaunch the gateway with the upgraded bundle.",
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
	file, err := os.Create(tmp)
	if err != nil {
		return nil, err
	}
	hasher := sha256.New()
	if err := downloadBundle(spec.URL, io.MultiWriter(file, hasher)); err != nil {
		_ = file.Close()
		_ = os.Remove(tmp)
		return nil, err
	}
	if err := file.Close(); err != nil {
		return nil, err
	}
	gotSHA := hex.EncodeToString(hasher.Sum(nil))
	if !strings.EqualFold(gotSHA, spec.SHA256) {
		_ = os.Remove(tmp)
		return nil, fmt.Errorf("bundle checksum mismatch for %s: expected %s, got %s", spec.URL, spec.SHA256, gotSHA)
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
	releaseURL := os.Getenv("RVWR_RELEASE_API_URL")
	if releaseURL == "" {
		releaseURL = "https://api.github.com/repos/verivus-oss/llm-cli-gateway/releases/latest"
	}

	body, err := getURL(releaseURL)
	if err != nil {
		return bundleSpec{}, err
	}
	var release githubRelease
	if err := json.Unmarshal(body, &release); err != nil {
		return bundleSpec{}, fmt.Errorf("parse latest release metadata: %w", err)
	}
	version := strings.TrimPrefix(release.TagName, "v")
	if version == "" {
		return bundleSpec{}, errors.New("latest release metadata did not include tag_name")
	}

	bundleName := fmt.Sprintf("llm-cli-gateway-bundle-%s-%s-%s.tar.gz", version, runtime.GOOS, runtime.GOARCH)
	bundleURL, ok := releaseAssetURL(release, bundleName)
	if !ok {
		return bundleSpec{}, fmt.Errorf("latest release %s does not include %s", release.TagName, bundleName)
	}
	checksumsURL, ok := releaseAssetURL(release, "SHA256SUMS")
	if !ok {
		return bundleSpec{}, fmt.Errorf("latest release %s does not include SHA256SUMS", release.TagName)
	}

	checksums, err := getURL(checksumsURL)
	if err != nil {
		return bundleSpec{}, err
	}
	sha, err := shaFromChecksums(string(checksums), bundleName)
	if err != nil {
		return bundleSpec{}, err
	}
	return bundleSpec{
		URL:     bundleURL,
		SHA256:  sha,
		Name:    bundleName,
		Version: version,
		Source:  "github-latest",
	}, nil
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
