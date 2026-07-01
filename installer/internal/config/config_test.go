package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
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

func TestPublicURLDoesNotEnableNoAuthChatGPTPath(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", os.Getenv("HOME"))
	}

	settings, err := SetPublicURL("https://example.trycloudflare.com/mcp", true)
	if err != nil {
		t.Fatalf("SetPublicURL returned error: %v", err)
	}
	if settings.ChatGPTNoAuthPath != "" {
		t.Fatalf("ChatGPTNoAuthPath = %q", settings.ChatGPTNoAuthPath)
	}

	cfg, err := Default()
	if err != nil {
		t.Fatalf("Default returned error: %v", err)
	}
	if cfg.ChatGPTConnectorURL != "" {
		t.Fatalf("cfg.ChatGPTConnectorURL = %q", cfg.ChatGPTConnectorURL)
	}
	for _, item := range EnvForGateway(cfg, "token") {
		if strings.HasPrefix(item, "LLM_GATEWAY_NO_AUTH_PATHS=") {
			t.Fatalf("EnvForGateway exposed deprecated no-auth path: %#v", item)
		}
	}
}

func TestDoctorJSONRedactsDeprecatedChatGPTConnectorURL(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", os.Getenv("HOME"))
	}

	cfg, err := Default()
	if err != nil {
		t.Fatalf("Default returned error: %v", err)
	}
	if err := writeSettings(cfg.AppDir, Settings{
		PublicURL:           "https://example.trycloudflare.com/mcp",
		ChatGPTNoAuthPath:   "/chatgpt/SECRET123/mcp",
		ChatGPTConnectorURL: "https://example.trycloudflare.com/chatgpt/SECRET123/mcp",
	}); err != nil {
		t.Fatalf("writeSettings returned error: %v", err)
	}

	body, err := DoctorJSON()
	if err != nil {
		t.Fatalf("DoctorJSON returned error: %v", err)
	}
	if strings.Contains(string(body), "SECRET123") {
		t.Fatalf("DoctorJSON leaked deprecated no-auth secret: %s", body)
	}
	var report map[string]any
	if err := json.Unmarshal(body, &report); err != nil {
		t.Fatalf("unmarshal doctor report: %v", err)
	}
	transport := report["transport"].(map[string]any)
	httpReport := transport["http"].(map[string]any)
	if httpReport["chatgpt_connector_url"] != "<redacted>" {
		t.Fatalf("chatgpt_connector_url = %v", httpReport["chatgpt_connector_url"])
	}
}

func TestOAuthURLsNormalizeTrailingSlash(t *testing.T) {
	// A trailing-slash origin must not yield a double-slash URL: the installer
	// must match src/remote-url.ts joinBaseAndPath (no drift).
	for _, origin := range []string{"https://example.com", "https://example.com/"} {
		urls := OAuthURLs(origin)
		if urls["authorization_url"] != "https://example.com/oauth/authorize" {
			t.Fatalf("authorization_url = %v for origin %q", urls["authorization_url"], origin)
		}
		if urls["protected_resource_url"] != "https://example.com/.well-known/oauth-protected-resource" {
			t.Fatalf("protected_resource_url = %v for origin %q", urls["protected_resource_url"], origin)
		}
	}
	if got := JoinBaseAndPath("https://example.com/", "/mcp"); got != "https://example.com/mcp" {
		t.Fatalf("JoinBaseAndPath double-slash: %q", got)
	}
}

func TestDoctorJSONFallbackIncludesRemoteHTTPOAuth(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", os.Getenv("HOME"))
	}
	cfg, err := Default()
	if err != nil {
		t.Fatalf("Default returned error: %v", err)
	}
	if err := writeSettings(cfg.AppDir, Settings{
		PublicURL: "https://example.trycloudflare.com/mcp",
	}); err != nil {
		t.Fatalf("writeSettings returned error: %v", err)
	}

	body, err := DoctorJSON()
	if err != nil {
		t.Fatalf("DoctorJSON returned error: %v", err)
	}
	var report map[string]any
	if err := json.Unmarshal(body, &report); err != nil {
		t.Fatalf("unmarshal doctor report: %v", err)
	}
	remote, ok := report["remote_http_oauth"].(map[string]any)
	if !ok {
		t.Fatalf("remote_http_oauth block missing from fallback doctor report")
	}
	// With a public HTTPS URL but no configured client, the fallback stage is
	// missing_oauth_client (the next blocking action).
	if remote["stage"] != "missing_oauth_client" {
		t.Fatalf("stage = %v, want missing_oauth_client", remote["stage"])
	}
	if remote["auth_mode"] != "oauth" {
		t.Fatalf("auth_mode = %v, want oauth", remote["auth_mode"])
	}
	if remote["mcp_url"] != "https://example.trycloudflare.com/mcp" {
		t.Fatalf("mcp_url = %v", remote["mcp_url"])
	}
	oauth := remote["oauth"].(map[string]any)
	if oauth["authorization_url"] != "https://example.trycloudflare.com/oauth/authorize" {
		t.Fatalf("authorization_url = %v", oauth["authorization_url"])
	}
	// Never a secret or hash in the readiness block.
	if strings.Contains(string(body), "scrypt:") || strings.Contains(string(body), "client_secret_hash") {
		t.Fatalf("remote_http_oauth leaked secret material: %s", body)
	}
}

func TestDoctorJSONFallbackRemoteHTTPOAuthMissingPublicURL(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", os.Getenv("HOME"))
	}
	body, err := DoctorJSON()
	if err != nil {
		t.Fatalf("DoctorJSON returned error: %v", err)
	}
	var report map[string]any
	if err := json.Unmarshal(body, &report); err != nil {
		t.Fatalf("unmarshal doctor report: %v", err)
	}
	remote := report["remote_http_oauth"].(map[string]any)
	if remote["stage"] != "missing_public_url" {
		t.Fatalf("stage = %v, want missing_public_url", remote["stage"])
	}
	if remote["mcp_url"] != nil {
		t.Fatalf("mcp_url should be null without a public URL, got %v", remote["mcp_url"])
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
