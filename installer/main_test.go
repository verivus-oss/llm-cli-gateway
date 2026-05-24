package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"runtime"
	"testing"
)

func TestBundleSpecFromEnv(t *testing.T) {
	t.Setenv("RVWR_GATEWAY_BUNDLE_URL", " https://example.test/bundle.tar.gz ")
	t.Setenv("RVWR_GATEWAY_BUNDLE_SHA256", " ABCDEF ")

	spec, err := bundleSpecFromEnv()
	if err != nil {
		t.Fatalf("bundleSpecFromEnv returned error: %v", err)
	}
	if spec.URL != "https://example.test/bundle.tar.gz" {
		t.Fatalf("URL = %q", spec.URL)
	}
	if spec.SHA256 != "ABCDEF" {
		t.Fatalf("SHA256 = %q", spec.SHA256)
	}
	if spec.Name != "bundle.tar.gz" {
		t.Fatalf("Name = %q", spec.Name)
	}
	if spec.Source != "env" {
		t.Fatalf("Source = %q", spec.Source)
	}
}

func TestBundleSpecFromEnvRequiresURLAndSHA(t *testing.T) {
	t.Setenv("RVWR_GATEWAY_BUNDLE_URL", "https://example.test/bundle.tar.gz")
	t.Setenv("RVWR_GATEWAY_BUNDLE_SHA256", "")

	if _, err := bundleSpecFromEnv(); err == nil {
		t.Fatal("expected error when only one bundle env var is set")
	}
}

func TestShaFromChecksums(t *testing.T) {
	checksums := []string{
		"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  other-file",
		"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB  target.tar.gz",
	}
	sha, err := shaFromChecksums(checksums[0]+"\n"+checksums[1]+"\n", "target.tar.gz")
	if err != nil {
		t.Fatalf("shaFromChecksums returned error: %v", err)
	}
	if sha != "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" {
		t.Fatalf("sha = %q", sha)
	}
}

func TestLatestReleaseSpecsIncludesBootstrapper(t *testing.T) {
	version := "9.8.7"
	bundleName := fmt.Sprintf("llm-cli-gateway-bundle-%s-%s-%s.tar.gz", version, runtime.GOOS, runtime.GOARCH)
	bootstrapperName := bootstrapperAssetName(version)
	bundleSHA := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	bootstrapperSHA := "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

	mux := http.NewServeMux()
	server := httptest.NewServer(mux)
	defer server.Close()
	mux.HandleFunc("/release", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tag_name": "v" + version,
			"assets": []map[string]string{
				{"name": bundleName, "browser_download_url": server.URL + "/" + bundleName},
				{"name": bootstrapperName, "browser_download_url": server.URL + "/" + bootstrapperName},
				{"name": "SHA256SUMS", "browser_download_url": server.URL + "/SHA256SUMS"},
			},
		})
	})
	mux.HandleFunc("/SHA256SUMS", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "%s  %s\n%s  %s\n", bundleSHA, bundleName, bootstrapperSHA, bootstrapperName)
	})
	t.Setenv("RVWR_RELEASE_API_URL", server.URL+"/release")

	specs, err := latestReleaseSpecs()
	if err != nil {
		t.Fatalf("latestReleaseSpecs returned error: %v", err)
	}
	if specs.Version != version {
		t.Fatalf("Version = %q", specs.Version)
	}
	if specs.Bundle.Name != bundleName || specs.Bundle.SHA256 != bundleSHA {
		t.Fatalf("Bundle = %#v", specs.Bundle)
	}
	if specs.Bootstrapper == nil {
		t.Fatal("Bootstrapper = nil")
	}
	if specs.Bootstrapper.Name != bootstrapperName || specs.Bootstrapper.SHA256 != bootstrapperSHA {
		t.Fatalf("Bootstrapper = %#v", specs.Bootstrapper)
	}
}

func TestPowershellSingleQuoted(t *testing.T) {
	got := powershellSingleQuoted(`C:\Users\O'Brien\llm-cli-gateway.exe`)
	want := `'C:\Users\O''Brien\llm-cli-gateway.exe'`
	if got != want {
		t.Fatalf("powershellSingleQuoted = %q", got)
	}
}
