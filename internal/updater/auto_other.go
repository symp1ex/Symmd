//go:build !windows

package updater

import "sync"

var autoCheckMu sync.Mutex

func withAutoCheckLock(action func() error) error {
	autoCheckMu.Lock()
	defer autoCheckMu.Unlock()
	return action()
}
