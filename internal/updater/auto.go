package updater

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/symp1ex/symmd/internal/settings"
)

const autoCheckInterval = time.Hour

type autoCheckLock func(func() error) error

func TryAutoCheck(now time.Time, start func() error) (bool, error) {
	configPath, err := settings.Path()
	if err != nil {
		return false, err
	}
	statePath := filepath.Join(filepath.Dir(configPath), "last-update-check")
	return tryAutoCheck(statePath, now, withAutoCheckLock, start)
}

func tryAutoCheck(statePath string, now time.Time, lock autoCheckLock, start func() error) (bool, error) {
	started := false
	err := lock(func() error {
		previous, readErr := os.ReadFile(statePath)
		previousExists := readErr == nil
		if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
			return fmt.Errorf("read automatic update state: %w", readErr)
		}
		if previousExists {
			last, parseErr := time.Parse(time.RFC3339Nano, string(previous))
			if parseErr == nil && now.Sub(last) < autoCheckInterval {
				return nil
			}
		}
		if err := os.MkdirAll(filepath.Dir(statePath), 0o755); err != nil {
			return fmt.Errorf("create automatic update state directory: %w", err)
		}
		if err := os.WriteFile(statePath, []byte(now.Format(time.RFC3339Nano)), 0o600); err != nil {
			return fmt.Errorf("write automatic update state: %w", err)
		}
		if err := start(); err != nil {
			var restoreErr error
			if previousExists {
				restoreErr = os.WriteFile(statePath, previous, 0o600)
			} else {
				restoreErr = os.Remove(statePath)
				if errors.Is(restoreErr, os.ErrNotExist) {
					restoreErr = nil
				}
			}
			if restoreErr != nil {
				return errors.Join(err, fmt.Errorf("restore automatic update state: %w", restoreErr))
			}
			return err
		}
		started = true
		return nil
	})
	return started, err
}
