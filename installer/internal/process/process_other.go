//go:build !windows

package process

import "os/exec"

func configureHiddenProcess(_ *exec.Cmd) {}
