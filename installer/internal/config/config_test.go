package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestDoctorJSONReportsInstalledGatewayVersionInFallback(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", os.Getenv("HOME"))
	}
	GatewayVersion = "bootstrapper-test"

	cfg, err := Default()
	if err != nil {
		t.Fatalf("Default returned error: %v", err)
	}
	if err := os.MkdirAll(cfg.GatewayDir, 0o700); err != nil {
		t.Fatalf("mkdir gateway dir: %v", err)
	}
	if err := os.WriteFile(
		filepath.Join(cfg.GatewayDir, "package.json"),
		[]byte(`{"version":"bundle-test"}`),
		0o600,
	); err != nil {
		t.Fatalf("write package.json: %v", err)
	}

	body, err := DoctorJSON()
	if err != nil {
		t.Fatalf("DoctorJSON returned error: %v", err)
	}
	var report map[string]any
	if err := json.Unmarshal(body, &report); err != nil {
		t.Fatalf("unmarshal doctor report: %v", err)
	}
	gateway := report["gateway"].(map[string]any)
	if gateway["version"] != "bundle-test" {
		t.Fatalf("gateway.version = %v", gateway["version"])
	}
	if gateway["bootstrapper_version"] != "bootstrapper-test" {
		t.Fatalf("gateway.bootstrapper_version = %v", gateway["bootstrapper_version"])
	}
	if gateway["diagnostic_source"] != "bootstrapper-fallback" {
		t.Fatalf("gateway.diagnostic_source = %v", gateway["diagnostic_source"])
	}
}

func TestSetPublicURLPersistsForDefaultAndGatewayEnv(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", os.Getenv("HOME"))
	}

	settings, err := SetPublicURL("https://example.trycloudflare.com", true)
	if err != nil {
		t.Fatalf("SetPublicURL returned error: %v", err)
	}
	if settings.PublicURL != "https://example.trycloudflare.com/mcp" {
		t.Fatalf("PublicURL = %q", settings.PublicURL)
	}

	cfg, err := Default()
	if err != nil {
		t.Fatalf("Default returned error: %v", err)
	}
	if cfg.PublicURL != "https://example.trycloudflare.com/mcp" {
		t.Fatalf("cfg.PublicURL = %q", cfg.PublicURL)
	}
	if !cfg.VerifyPublicURL {
		t.Fatal("cfg.VerifyPublicURL = false")
	}

	env := EnvForGateway(cfg, "token")
	if !contains(env, "LLM_GATEWAY_PUBLIC_URL=https://example.trycloudflare.com/mcp") {
		t.Fatalf("EnvForGateway missing public URL: %#v", env)
	}
	if !contains(env, "LLM_GATEWAY_VERIFY_PUBLIC_URL=1") {
		t.Fatalf("EnvForGateway missing verify flag: %#v", env)
	}
}

func TestChatGPTConnectorURLUsesNoAuthPath(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", os.Getenv("HOME"))
	}

	settings, err := SetPublicURL("https://example.trycloudflare.com/mcp", true)
	if err != nil {
		t.Fatalf("SetPublicURL returned error: %v", err)
	}
	chatGPTSettings, err := SetChatGPTURLFromPublicURL(settings.PublicURL)
	if err != nil {
		t.Fatalf("SetChatGPTURLFromPublicURL returned error: %v", err)
	}
	if chatGPTSettings.ChatGPTNoAuthPath == "" {
		t.Fatal("ChatGPTNoAuthPath is empty")
	}
	if chatGPTSettings.ChatGPTConnectorURL != "https://example.trycloudflare.com"+chatGPTSettings.ChatGPTNoAuthPath {
		t.Fatalf("ChatGPTConnectorURL = %q", chatGPTSettings.ChatGPTConnectorURL)
	}

	cfg, err := Default()
	if err != nil {
		t.Fatalf("Default returned error: %v", err)
	}
	if cfg.ChatGPTConnectorURL != chatGPTSettings.ChatGPTConnectorURL {
		t.Fatalf("cfg.ChatGPTConnectorURL = %q", cfg.ChatGPTConnectorURL)
	}
	if !contains(EnvForGateway(cfg, "token"), "LLM_GATEWAY_NO_AUTH_PATHS="+chatGPTSettings.ChatGPTNoAuthPath) {
		t.Fatalf("EnvForGateway missing ChatGPT no-auth path")
	}
}

func TestNormalizePublicURLRequiresHTTPS(t *testing.T) {
	if _, err := NormalizePublicURL("http://127.0.0.1:3333/mcp", "/mcp"); err == nil {
		t.Fatal("expected http URL to be rejected")
	}
}

func TestPublicURLEnvOverridesPersistedSetting(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", os.Getenv("HOME"))
	}
	if _, err := SetPublicURL("https://persisted.example.com/mcp", true); err != nil {
		t.Fatalf("SetPublicURL returned error: %v", err)
	}
	t.Setenv("LLM_GATEWAY_PUBLIC_URL", "https://env.example.com/mcp")

	cfg, err := Default()
	if err != nil {
		t.Fatalf("Default returned error: %v", err)
	}
	if cfg.PublicURL != "https://env.example.com/mcp" {
		t.Fatalf("cfg.PublicURL = %q", cfg.PublicURL)
	}
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
