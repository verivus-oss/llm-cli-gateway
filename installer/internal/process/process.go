package process

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"

	"github.com/verivusai-labs/llm-cli-gateway/installer/internal/config"
)

type Status struct {
	Running bool `json:"running"`
	PID     int  `json:"pid,omitempty"`
}

func Start(cfg config.Config, token string) (Status, error) {
	if status, _ := Current(cfg); status.Running {
		return status, nil
	}
	entry := filepath.Join(cfg.GatewayDir, "dist", "index.js")
	if _, err := os.Stat(entry); err != nil {
		return Status{}, errors.New("gateway bundle missing; install a verified bundle before start")
	}
	cmd := exec.Command("node", entry, "--transport=http")
	cmd.Env = config.EnvForGateway(cfg, token)
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return Status{}, err
	}
	if err := os.WriteFile(pidPath(cfg), []byte(strconv.Itoa(cmd.Process.Pid)), 0o600); err != nil {
		return Status{}, err
	}
	return Status{Running: true, PID: cmd.Process.Pid}, nil
}

func Stop(cfg config.Config) error {
	status, err := Current(cfg)
	if err != nil || !status.Running {
		_ = os.Remove(pidPath(cfg))
		return nil
	}
	process, err := os.FindProcess(status.PID)
	if err != nil {
		_ = os.Remove(pidPath(cfg))
		return nil
	}
	_ = process.Signal(syscall.SIGTERM)
	_ = os.Remove(pidPath(cfg))
	return nil
}

func Current(cfg config.Config) (Status, error) {
	raw, err := os.ReadFile(pidPath(cfg))
	if err != nil {
		return Status{Running: false}, nil
	}
	pid, err := strconv.Atoi(string(raw))
	if err != nil {
		return Status{Running: false}, err
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return Status{Running: false}, nil
	}
	if err := process.Signal(syscall.Signal(0)); err != nil {
		return Status{Running: false, PID: pid}, nil
	}
	return Status{Running: true, PID: pid}, nil
}

func pidPath(cfg config.Config) string {
	return filepath.Join(cfg.AppDir, "gateway.pid")
}
