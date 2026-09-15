//go:build windows

package updater

import (
	"fmt"
	"runtime"

	"golang.org/x/sys/windows"
)

func withAutoCheckLock(action func() error) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	name, err := windows.UTF16PtrFromString(`Local\symmd-updater-auto-check`)
	if err != nil {
		return fmt.Errorf("encode automatic update mutex name: %w", err)
	}
	handle, err := windows.CreateMutex(nil, false, name)
	if err != nil {
		return fmt.Errorf("create automatic update mutex: %w", err)
	}
	defer windows.CloseHandle(handle)
	result, err := windows.WaitForSingleObject(handle, windows.INFINITE)
	if err != nil {
		return fmt.Errorf("wait for automatic update mutex: %w", err)
	}
	if result != windows.WAIT_OBJECT_0 && result != windows.WAIT_ABANDONED {
		return fmt.Errorf("wait for automatic update mutex: unexpected result 0x%x", result)
	}
	defer windows.ReleaseMutex(handle)
	return action()
}
