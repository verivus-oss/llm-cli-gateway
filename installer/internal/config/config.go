package config

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

var GatewayVersion = "dev"

type Config struct {
	AppDir              string `json:"app_dir"`
	GatewayDir          string `json:"gateway_dir"`
	RuntimeDir          string `json:"runtime_dir"`
	RuntimeNode         string `json:"runtime_node"`
	HTTPHost            string `json:"http_host"`
	HTTPPort            string `json:"http_port"`
	HTTPPath            string `json:"http_path"`
	PublicURL           string `json:"public_url,omitempty"`
	VerifyPublicURL     bool   `json:"verify_public_url,omitempty"`
	ChatGPTNoAuthPath   string `json:"chatgpt_no_auth_path,omitempty"`
	ChatGPTConnectorURL string `json:"chatgpt_connector_url,omitempty"`
	AuthTokenSet        bool   `json:"auth_token_set"`
}

type Settings struct {
	PublicURL           string `json:"public_url,omitempty"`
	VerifyPublicURL     bool   `json:"verify_public_url,omitempty"`
	ChatGPTNoAuthPath   string `json:"chatgpt_no_auth_path,omitempty"`
	ChatGPTConnectorURL string `json:"chatgpt_connector_url,omitempty"`
}

func Default() (Config, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return Config{}, err
	}
	appDir := filepath.Join(home, ".llm-cli-gateway")
	runtimeDir := filepath.Join(appDir, "runtime")
	settings := readSettings(appDir)
	publicURL := strings.TrimSpace(os.Getenv("LLM_GATEWAY_PUBLIC_URL"))
	if publicURL == "" {
		publicURL = settings.PublicURL
	}
	verifyPublicURL := settings.VerifyPublicURL || os.Getenv("LLM_GATEWAY_VERIFY_PUBLIC_URL") == "1"
	return Config{
		AppDir:              appDir,
		GatewayDir:          filepath.Join(appDir, "gateway"),
		RuntimeDir:          runtimeDir,
		RuntimeNode:         filepath.Join(runtimeDir, nodeExecutableName()),
		HTTPHost:            envDefault("LLM_GATEWAY_HTTP_HOST", "127.0.0.1"),
		HTTPPort:            envDefault("LLM_GATEWAY_HTTP_PORT", "3333"),
		HTTPPath:            envDefault("LLM_GATEWAY_HTTP_PATH", "/mcp"),
		PublicURL:           publicURL,
		VerifyPublicURL:     verifyPublicURL,
		ChatGPTNoAuthPath:   settings.ChatGPTNoAuthPath,
		ChatGPTConnectorURL: settings.ChatGPTConnectorURL,
	}, nil
}

func SetPublicURL(rawURL string, verify bool) (Settings, error) {
	cfg, err := Default()
	if err != nil {
		return Settings{}, err
	}
	normalized, err := NormalizePublicURL(rawURL, cfg.HTTPPath)
	if err != nil {
		return Settings{}, err
	}
	settings := readSettings(cfg.AppDir)
	settings.PublicURL = normalized
	settings.VerifyPublicURL = verify
	if err := writeSettings(cfg.AppDir, settings); err != nil {
		return Settings{}, err
	}
	return settings, nil
}

func ClearPublicURL() error {
	cfg, err := Default()
	if err != nil {
		return err
	}
	settings := readSettings(cfg.AppDir)
	settings.PublicURL = ""
	settings.VerifyPublicURL = false
	settings.ChatGPTConnectorURL = ""
	return writeSettings(cfg.AppDir, settings)
}

func EnsureChatGPTNoAuthPath() (Settings, bool, error) {
	cfg, err := Default()
	if err != nil {
		return Settings{}, false, err
	}
	settings := readSettings(cfg.AppDir)
	if settings.ChatGPTNoAuthPath != "" {
		return settings, false, nil
	}
	path, err := randomChatGPTNoAuthPath()
	if err != nil {
		return Settings{}, false, err
	}
	settings.ChatGPTNoAuthPath = path
	if settings.PublicURL != "" {
		if connectorURL, err := chatGPTConnectorURL(settings.PublicURL, path); err == nil {
			settings.ChatGPTConnectorURL = connectorURL
		}
	}
	if err := writeSettings(cfg.AppDir, settings); err != nil {
		return Settings{}, false, err
	}
	return settings, true, nil
}

func SetChatGPTURLFromPublicURL(rawURL string) (Settings, error) {
	cfg, err := Default()
	if err != nil {
		return Settings{}, err
	}
	settings := readSettings(cfg.AppDir)
	if settings.ChatGPTNoAuthPath == "" {
		path, err := randomChatGPTNoAuthPath()
		if err != nil {
			return Settings{}, err
		}
		settings.ChatGPTNoAuthPath = path
	}
	connectorURL, err := chatGPTConnectorURL(rawURL, settings.ChatGPTNoAuthPath)
	if err != nil {
		return Settings{}, err
	}
	settings.ChatGPTConnectorURL = connectorURL
	if err := writeSettings(cfg.AppDir, settings); err != nil {
		return Settings{}, err
	}
	return settings, nil
}

func RotateChatGPTURL() (Settings, error) {
	cfg, err := Default()
	if err != nil {
		return Settings{}, err
	}
	settings := readSettings(cfg.AppDir)
	path, err := randomChatGPTNoAuthPath()
	if err != nil {
		return Settings{}, err
	}
	settings.ChatGPTNoAuthPath = path
	settings.ChatGPTConnectorURL = ""
	if settings.PublicURL != "" {
		if connectorURL, err := chatGPTConnectorURL(settings.PublicURL, path); err == nil {
			settings.ChatGPTConnectorURL = connectorURL
		}
	}
	if err := writeSettings(cfg.AppDir, settings); err != nil {
		return Settings{}, err
	}
	return settings, nil
}

func ClearChatGPTURL() error {
	cfg, err := Default()
	if err != nil {
		return err
	}
	settings := readSettings(cfg.AppDir)
	settings.ChatGPTConnectorURL = ""
	settings.ChatGPTNoAuthPath = ""
	return writeSettings(cfg.AppDir, settings)
}

func NormalizePublicURL(rawURL, defaultPath string) (string, error) {
	trimmed := strings.TrimSpace(rawURL)
	if trimmed == "" {
		return "", errors.New("public URL is required")
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", errors.New("public URL must be an absolute HTTPS URL")
	}
	if parsed.Scheme != "https" {
		return "", errors.New("public URL must use https:// for ChatGPT and other web clients")
	}
	if parsed.Path == "" || parsed.Path == "/" {
		parsed.Path = defaultPath
	}
	return parsed.String(), nil
}

func chatGPTConnectorURL(rawURL, noAuthPath string) (string, error) {
	path := normalizeNoAuthPath(noAuthPath)
	if path == "" {
		return "", errors.New("ChatGPT no-auth path is required")
	}
	normalized, err := NormalizePublicURL(rawURL, "/mcp")
	if err != nil {
		return "", err
	}
	parsed, err := url.Parse(normalized)
	if err != nil {
		return "", err
	}
	parsed.Path = path
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
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
	if body, ok := nodeDoctorJSON(cfg); ok {
		return body, nil
	}
	_, err = os.Stat(filepath.Join(cfg.AppDir, "auth-token"))
	cfg.AuthTokenSet = err == nil
	port, err := strconv.Atoi(cfg.HTTPPort)
	if err != nil {
		port = 3333
	}
	publicURL := cfg.PublicURL
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
			"name":                  "llm-cli-gateway",
			"version":               installedGatewayVersion(cfg),
			"bootstrapper_version":  GatewayVersion,
			"diagnostic_source":     "bootstrapper-fallback",
			"diagnostic_limitation": "Provider runtime status is only checked by the installed Node gateway doctor.",
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
				"chatgpt_connector_url": nullableString(redactDiagnosticURL(cfg.ChatGPTConnectorURL)),
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

func nodeDoctorJSON(cfg Config) ([]byte, bool) {
	entry := filepath.Join(cfg.GatewayDir, "dist", "index.js")
	if _, err := os.Stat(entry); err != nil {
		return nil, false
	}
	nodePath := cfg.RuntimeNode
	if _, err := os.Stat(nodePath); err != nil {
		if os.Getenv("RVWR_ALLOW_HOST_NODE") != "1" {
			return nil, false
		}
		nodePath = "node"
	}

	token := ""
	if raw, err := os.ReadFile(filepath.Join(cfg.AppDir, "auth-token")); err == nil {
		token = string(raw)
	}

	cmd := exec.Command(nodePath, entry, "doctor", "--json")
	cmd.Env = EnvForGateway(cfg, token)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	output, err := cmd.Output()
	if err != nil {
		return nil, false
	}

	var report map[string]any
	if err := json.Unmarshal(output, &report); err != nil {
		return nil, false
	}
	gateway, _ := report["gateway"].(map[string]any)
	if gateway == nil {
		gateway = map[string]any{}
	}
	gateway["bootstrapper_version"] = GatewayVersion
	gateway["diagnostic_source"] = "node-gateway"
	report["gateway"] = gateway

	body, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return nil, false
	}
	return body, true
}

func installedGatewayVersion(cfg Config) string {
	body, err := os.ReadFile(filepath.Join(cfg.GatewayDir, "package.json"))
	if err != nil {
		return GatewayVersion
	}
	var pkg struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(body, &pkg); err != nil || pkg.Version == "" {
		return GatewayVersion
	}
	return pkg.Version
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
	if cfg.PublicURL != "" {
		env = append(env, "LLM_GATEWAY_PUBLIC_URL="+cfg.PublicURL)
	}
	if cfg.VerifyPublicURL {
		env = append(env, "LLM_GATEWAY_VERIFY_PUBLIC_URL=1")
	}
	if cfg.ChatGPTNoAuthPath != "" {
		env = append(env, "LLM_GATEWAY_NO_AUTH_PATHS="+cfg.ChatGPTNoAuthPath)
	}
	return env
}

func envDefault(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func nodeExecutableName() string {
	if runtime.GOOS == "windows" {
		return "node.exe"
	}
	return "node"
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

func randomChatGPTNoAuthPath() (string, error) {
	token, err := randomToken()
	if err != nil {
		return "", err
	}
	return "/chatgpt/" + token + "/mcp", nil
}

func normalizeNoAuthPath(path string) string {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" || !strings.HasPrefix(trimmed, "/") {
		return ""
	}
	if strings.ContainsAny(trimmed, "?#") || strings.Contains(trimmed, "..") {
		return ""
	}
	return trimmed
}

func settingsPath(appDir string) string {
	return filepath.Join(appDir, "settings.json")
}

func readSettings(appDir string) Settings {
	body, err := os.ReadFile(settingsPath(appDir))
	if err != nil {
		return Settings{}
	}
	var settings Settings
	if err := json.Unmarshal(body, &settings); err != nil {
		return Settings{}
	}
	settings.PublicURL = strings.TrimSpace(settings.PublicURL)
	settings.ChatGPTNoAuthPath = normalizeNoAuthPath(settings.ChatGPTNoAuthPath)
	settings.ChatGPTConnectorURL = strings.TrimSpace(settings.ChatGPTConnectorURL)
	return settings
}

func writeSettings(appDir string, settings Settings) error {
	if err := os.MkdirAll(appDir, 0o700); err != nil {
		return err
	}
	body, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	body = append(body, '\n')
	return os.WriteFile(settingsPath(appDir), body, 0o600)
}
