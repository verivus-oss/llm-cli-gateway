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
