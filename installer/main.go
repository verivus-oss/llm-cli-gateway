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
	"strings"

	"github.com/verivusai-labs/llm-cli-gateway/installer/internal/config"
	"github.com/verivusai-labs/llm-cli-gateway/installer/internal/process"
	"github.com/verivusai-labs/llm-cli-gateway/installer/internal/setupui"
)

func main() {
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

func upgrade() error {
	// `upgrade` is idempotent: it stops the gateway (if running), runs the
	// same verified bundle download path as `install-bundle`, then leaves
	// the bootstrapper for the user to `start` again. Config and auth
	// token are preserved across upgrades.
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
	if err := installBundle(); err != nil {
		return err
	}
	return printJSON(map[string]any{
		"ok":                 true,
		"action":             "upgrade",
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
	url := os.Getenv("RVWR_GATEWAY_BUNDLE_URL")
	wantSHA := os.Getenv("RVWR_GATEWAY_BUNDLE_SHA256")
	if url == "" || wantSHA == "" {
		return errors.New("set RVWR_GATEWAY_BUNDLE_URL and RVWR_GATEWAY_BUNDLE_SHA256")
	}
	cfg, _, err := config.Ensure()
	if err != nil {
		return err
	}
	tmp := filepath.Join(cfg.AppDir, "gateway-bundle.tmp")
	file, err := os.Create(tmp)
	if err != nil {
		return err
	}
	hasher := sha256.New()
	if err := downloadBundle(url, io.MultiWriter(file, hasher)); err != nil {
		_ = file.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	gotSHA := hex.EncodeToString(hasher.Sum(nil))
	if gotSHA != wantSHA {
		_ = os.Remove(tmp)
		return fmt.Errorf("bundle checksum mismatch")
	}
	installedRoot, err := installVerifiedBundle(tmp, cfg)
	_ = os.Remove(tmp)
	if err != nil {
		return err
	}
	return printJSON(map[string]any{"ok": true, "gateway_dir": installedRoot, "sha256": gotSHA})
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
	previous := cfg.GatewayDir + ".previous"
	if err := os.RemoveAll(previous); err != nil {
		return "", err
	}
	if _, err := os.Stat(cfg.GatewayDir); err == nil {
		if err := os.Rename(cfg.GatewayDir, previous); err != nil {
			return "", err
		}
	}
	if err := os.Rename(root, cfg.GatewayDir); err != nil {
		if _, statErr := os.Stat(previous); statErr == nil {
			_ = os.Rename(previous, cfg.GatewayDir)
		}
		return "", err
	}
	_ = os.RemoveAll(previous)
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

func printJSON(value any) error {
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(encoded))
	return nil
}
