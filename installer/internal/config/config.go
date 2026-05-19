package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	AppDir       string `json:"app_dir"`
	GatewayDir   string `json:"gateway_dir"`
	HTTPHost     string `json:"http_host"`
	HTTPPort     string `json:"http_port"`
	HTTPPath     string `json:"http_path"`
	AuthTokenSet bool   `json:"auth_token_set"`
}

func Default() (Config, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return Config{}, err
	}
	appDir := filepath.Join(home, ".llm-cli-gateway")
	return Config{
		AppDir:     appDir,
		GatewayDir: filepath.Join(appDir, "gateway"),
		HTTPHost:   envDefault("LLM_GATEWAY_HTTP_HOST", "127.0.0.1"),
		HTTPPort:   envDefault("LLM_GATEWAY_HTTP_PORT", "3333"),
		HTTPPath:   envDefault("LLM_GATEWAY_HTTP_PATH", "/mcp"),
	}, nil
}

func Ensure() (Config, string, error) {
	cfg, err := Default()
	if err != nil {
		return Config{}, "", err
	}
	if err := os.MkdirAll(cfg.GatewayDir, 0o700); err != nil {
		return Config{}, "", err
	}
	tokenPath := filepath.Join(cfg.AppDir, "auth-token")
	token, err := os.ReadFile(tokenPath)
	if err == nil && len(token) > 0 {
		cfg.AuthTokenSet = true
		return cfg, string(token), nil
	}
	generated, err := randomToken()
	if err != nil {
		return Config{}, "", err
	}
	if err := os.WriteFile(tokenPath, []byte(generated), 0o600); err != nil {
		return Config{}, "", err
	}
	cfg.AuthTokenSet = true
	return cfg, generated, nil
}

func DoctorJSON() ([]byte, error) {
	cfg, err := Default()
	if err != nil {
		return nil, err
	}
	_, err = os.Stat(filepath.Join(cfg.AppDir, "auth-token"))
	cfg.AuthTokenSet = err == nil
	port, err := strconv.Atoi(cfg.HTTPPort)
	if err != nil {
		port = 3333
	}
	publicURL := os.Getenv("LLM_GATEWAY_PUBLIC_URL")
	redactedPublicURL := redactDiagnosticURL(publicURL)
	httpsConfigured := strings.HasPrefix(publicURL, "https://")
	report := map[string]any{
		"schema_version": "1.0",
		"ok":             cfg.AuthTokenSet,
		"generated_at":   time.Now().UTC().Format(time.RFC3339),
		"system": map[string]any{
			"os":           runtime.GOOS,
			"arch":         runtime.GOARCH,
			"release":      "",
			"node_version": "",
		},
		"gateway": map[string]any{
			"name":    "llm-cli-gateway",
			"version": "bootstrapper",
		},
		"transport": map[string]any{
			"default": "http",
			"http": map[string]any{
				"enabled":               true,
				"host":                  cfg.HTTPHost,
				"port":                  port,
				"path":                  cfg.HTTPPath,
				"public_url_configured": publicURL != "",
				"public_url":            nullableString(redactedPublicURL),
			},
		},
		"auth": map[string]any{
			"required":         true,
			"token_configured": cfg.AuthTokenSet,
			"source":           "installer-auth-token-file",
		},
		"providers": map[string]any{
			"claude": providerDoctor("claude", "Claude Code"),
			"codex":  providerDoctor("codex", "Codex CLI"),
			"gemini": providerDoctor("gemini", "Gemini CLI"),
			"grok":   providerDoctor("grok", "Grok CLI"),
		},
		"endpoint_exposure": endpointExposureDoctor(cfg, publicURL, redactedPublicURL, httpsConfigured),
		"client_config": map[string]any{
			"claude_desktop_config_present": false,
			"codex_config_present":          false,
			"gemini_settings_present":       false,
		},
		"next_actions": nextActions(cfg.AuthTokenSet, publicURL, httpsConfigured),
	}
	return json.MarshalIndent(report, "", "  ")
}

func providerDoctor(provider, displayName string) map[string]any {
	return map[string]any{
		"cli_available":   false,
		"version":         nil,
		"login_status":    "not_checked",
		"version_command": []string{provider, "--version"},
		"login_check": map[string]any{
			"method":           "not_checked",
			"command":          nil,
			"credential_store": "not_checked",
			"detail":           "Provider runtime is checked by the Node gateway doctor after the bundle is installed.",
		},
		"install_guidance": map[string]any{
			"summary":  "Install " + displayName + " through the provider's official flow.",
			"commands": []string{},
		},
		"login_guidance": map[string]any{
			"summary":             "Sign in through " + displayName + "'s official login flow.",
			"commands":            []string{},
			"credential_handling": "Do not paste provider passwords, API keys, OAuth tokens, or credential files into chat.",
		},
	}
}

func endpointExposureDoctor(cfg Config, rawPublicURL, redactedPublicURL string, httpsConfigured bool) map[string]any {
	mode := "local_only"
	if rawPublicURL != "" && !httpsConfigured {
		mode = "misconfigured"
	} else if rawPublicURL != "" {
		mode = "byo_reverse_proxy"
	}
	return map[string]any{
		"mode":                   mode,
		"local_url":              "http://" + cfg.HTTPHost + ":" + cfg.HTTPPort + cfg.HTTPPath,
		"public_url_configured":  rawPublicURL != "",
		"public_url":             nullableString(redactedPublicURL),
		"https_required_for_web": true,
		"https_configured":       httpsConfigured,
		"web_clients_supported":  false,
		"tunnel_provider":        nil,
		"reachable_from_web":     "not_checked",
		"verification": map[string]any{
			"method":      "not_checked",
			"checked_url": nullableString(redactedPublicURL),
			"status_code": nil,
			"error":       nil,
		},
		"next_actions": nextActions(true, rawPublicURL, httpsConfigured),
	}
}

func redactDiagnosticURL(raw string) string {
	if raw == "" {
		return ""
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return redactSensitivePairs(stripUserInfo(raw))
	}
	parsed.User = nil
	query := parsed.Query()
	for key := range query {
		if sensitiveKeyPattern.MatchString(key) {
			query.Set(key, "<redacted>")
		}
	}
	parsed.RawQuery = query.Encode()
	parsed.Fragment = redactSensitivePairs(parsed.Fragment)
	return strings.ReplaceAll(parsed.String(), "%3Credacted%3E", "<redacted>")
}

var sensitiveKeyPattern = regexp.MustCompile(`(?i)auth|bearer|token|secret|credential|password|authorization|signature|api[_-]?key|access[_-]?key|jwt|cookie|session`)

func redactSensitivePairs(value string) string {
	pairPattern := regexp.MustCompile(`(?i)((?:auth|bearer|token|secret|credential|password|authorization|signature|api[_-]?key|access[_-]?key|jwt|cookie|session)=)[^&\s#]+`)
	return pairPattern.ReplaceAllString(value, "$1<redacted>")
}

func stripUserInfo(value string) string {
	userInfoPattern := regexp.MustCompile(`(?i)(https?://)[^/@]+@`)
	return userInfoPattern.ReplaceAllString(value, "$1")
}

func nextActions(authTokenSet bool, publicURL string, httpsConfigured bool) []string {
	actions := []string{}
	if !authTokenSet {
		actions = append(actions, "Run setup to create the local bearer token before starting HTTP transport.")
	}
	if publicURL == "" {
		actions = append(actions, "Use local clients now, or configure an HTTPS tunnel before web-client setup.")
	} else if !httpsConfigured {
		actions = append(actions, "Replace the public URL with HTTPS before configuring web clients.")
	} else {
		actions = append(actions, "Run the Node gateway doctor with public URL verification before configuring web clients.")
	}
	return actions
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func EnvForGateway(cfg Config, token string) []string {
	env := os.Environ()
	env = append(env,
		"LLM_GATEWAY_TRANSPORT=http",
		"LLM_GATEWAY_HTTP_HOST="+cfg.HTTPHost,
		"LLM_GATEWAY_HTTP_PORT="+cfg.HTTPPort,
		"LLM_GATEWAY_HTTP_PATH="+cfg.HTTPPath,
		"LLM_GATEWAY_AUTH_TOKEN="+token,
	)
	return env
}

func envDefault(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func dirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func randomToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
