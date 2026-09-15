//go:build !windows

package updater

import "os/exec"

func setDetachedProcessAttributes(_ *exec.Cmd) {}

func resumeProcess(int) error { return nil }

func terminateOtherApplicationInstances(string) error { return nil }
