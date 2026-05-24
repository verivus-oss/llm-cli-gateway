package main

import "testing"

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
