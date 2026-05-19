package setupui

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"

	"github.com/verivusai-labs/llm-cli-gateway/installer/internal/config"
)

func Listen(addr string) error {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "text/html; charset=utf-8")
		body, err := readRepoFile("setup/ui/index.html")
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(
				"<!doctype html><title>llm-cli-gateway setup</title><h1>Setup UI unavailable</h1><p>Run doctor --json and use setup/ui/index.html from the release bundle.</p>",
			))
			return
		}
		_, _ = w.Write(body)
	})
	mux.Handle(
		"/setup/",
		http.StripPrefix("/setup/", http.FileServer(http.Dir(resolveRepoPath("setup")))),
	)
	mux.HandleFunc("/doctor", func(w http.ResponseWriter, _ *http.Request) {
		body, err := config.DoctorJSON()
		w.Header().Set("content-type", "application/json")
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": err.Error()})
			return
		}
		_, _ = w.Write(body)
	})
	return http.ListenAndServe(addr, mux)
}

func readRepoFile(rel string) ([]byte, error) {
	return os.ReadFile(resolveRepoPath(rel))
}

func resolveRepoPath(rel string) string {
	wd, err := os.Getwd()
	if err != nil {
		return rel
	}
	candidates := []string{
		filepath.Join(wd, rel),
		filepath.Join(wd, "..", rel),
		filepath.Join(wd, "..", "..", rel),
	}
	for _, candidate := range candidates {
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return filepath.Join(wd, rel)
}
