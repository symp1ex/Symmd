//go:build !windows

package files

import "os"

func replaceLogFile(source, destination string) error { return os.Rename(source, destination) }
