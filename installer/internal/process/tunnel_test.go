package process

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/verivus-oss/llm-cli-gateway/installer/internal/config"
)

func TestStartTunnelPersistsDiscoveredCloudflareURL(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", home)
	}
	cloudflared := fakeCloudflared(t)
	t.Setenv("LLM_GATEWAY_CLOUDFLARED_PATH", cloudflared)

	cfg, err := config.Default()
	if err != nil {
		t.Fatalf("Default returned error: %v", err)
	}

	status, err := StartTunnel(cfg, "cloudflare")
	if err != nil {
		t.Fatalf("StartTunnel returned error: %v", err)
	}
	defer StopTunnel(cfg)

	if !status.Running {
		t.Fatal("status.Running = false")
	}
	if status.PublicURL != "https://unit-test.trycloudflare.com/mcp" {
		t.Fatalf("status.PublicURL = %q", status.PublicURL)
	}
	if status.Provider != "cloudflare" {
		t.Fatalf("status.Provider = %q", status.Provider)
	}

	cfg, err = config.Default()
	if err != nil {
		t.Fatalf("Default after StartTunnel returned error: %v", err)
	}
	if cfg.PublicURL != "https://unit-test.trycloudflare.com/mcp" {
		t.Fatalf("cfg.PublicURL = %q", cfg.PublicURL)
	}
	if !cfg.VerifyPublicURL {
		t.Fatal("cfg.VerifyPublicURL = false")
	}
}

func TestStopTunnelClearsManagedPublicURL(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", home)
	}
	cloudflared := fakeCloudflared(t)
	t.Setenv("LLM_GATEWAY_CLOUDFLARED_PATH", cloudflared)

	cfg, err := config.Default()
	if err != nil {
		t.Fatalf("Default returned error: %v", err)
	}
	if _, err := StartTunnel(cfg, "cloudflare"); err != nil {
		t.Fatalf("StartTunnel returned error: %v", err)
	}
	if err := StopTunnel(cfg); err != nil {
		t.Fatalf("StopTunnel returned error: %v", err)
	}

	cfg, err = config.Default()
	if err != nil {
		t.Fatalf("Default after StopTunnel returned error: %v", err)
	}
	if cfg.PublicURL != "" {
		t.Fatalf("cfg.PublicURL = %q", cfg.PublicURL)
	}
}

func TestStopTunnelDoesNotClearUserPublicURL(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", home)
	}
	cloudflared := fakeCloudflared(t)
	t.Setenv("LLM_GATEWAY_CLOUDFLARED_PATH", cloudflared)

	cfg, err := config.Default()
	if err != nil {
		t.Fatalf("Default returned error: %v", err)
	}
	if _, err := StartTunnel(cfg, "cloudflare"); err != nil {
		t.Fatalf("StartTunnel returned error: %v", err)
	}
	if _, err := config.SetPublicURL("https://user.example.com/mcp", true); err != nil {
		t.Fatalf("SetPublicURL returned error: %v", err)
	}
	if err := StopTunnel(cfg); err != nil {
		t.Fatalf("StopTunnel returned error: %v", err)
	}

	cfg, err = config.Default()
	if err != nil {
		t.Fatalf("Default after StopTunnel returned error: %v", err)
	}
	if cfg.PublicURL != "https://user.example.com/mcp" {
		t.Fatalf("cfg.PublicURL = %q", cfg.PublicURL)
	}
}

func fakeCloudflared(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if runtime.GOOS == "windows" {
		path := filepath.Join(dir, "cloudflared.cmd")
		body := "@echo off\r\necho https://unit-test.trycloudflare.com\r\nping -n 60 127.0.0.1 >NUL\r\n"
		if err := os.WriteFile(path, []byte(body), 0o700); err != nil {
			t.Fatalf("write fake cloudflared: %v", err)
		}
		return path
	}
	path := filepath.Join(dir, "cloudflared")
	body := "#!/bin/sh\nprintf '%s\\n' 'https://unit-test.trycloudflare.com'\nsleep 60\n"
	if err := os.WriteFile(path, []byte(body), 0o700); err != nil {
		t.Fatalf("write fake cloudflared: %v", err)
	}
	return path
}
