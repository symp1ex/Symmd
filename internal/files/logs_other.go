//go:build !windows

package files

import "os"

func openLogFile(path string) (*os.File, error) { return os.Open(path) }
