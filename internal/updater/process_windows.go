//go:build windows

package updater

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	applicationExitWaitMilliseconds = 10_000
	createSuspended                 = 0x00000004
)

var queryFullProcessImageNameW = syscall.NewLazyDLL("kernel32.dll").NewProc("QueryFullProcessImageNameW")

type applicationProcess struct {
	handle windows.Handle
	pid    uint32
}

func setDetachedProcessAttributes(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP | createSuspended}
}

func resumeProcess(pid int) error {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		return fmt.Errorf("enumerate updater threads: %w", err)
	}
	defer windows.CloseHandle(snapshot)

	entry := windows.ThreadEntry32{Size: uint32(unsafe.Sizeof(windows.ThreadEntry32{}))}
	if err := windows.Thread32First(snapshot, &entry); err != nil {
		return fmt.Errorf("read updater thread snapshot: %w", err)
	}
	for {
		if entry.OwnerProcessID == uint32(pid) {
			thread, err := windows.OpenThread(windows.THREAD_SUSPEND_RESUME, false, entry.ThreadID)
			if err != nil {
				return fmt.Errorf("open updater thread %d: %w", entry.ThreadID, err)
			}
			_, resumeErr := windows.ResumeThread(thread)
			_ = windows.CloseHandle(thread)
			if resumeErr != nil {
				return fmt.Errorf("resume updater thread %d: %w", entry.ThreadID, resumeErr)
			}
			return nil
		}

		err = windows.Thread32Next(snapshot, &entry)
		if errors.Is(err, windows.ERROR_NO_MORE_FILES) {
			return fmt.Errorf("find updater thread for process %d", pid)
		}
		if err != nil {
			return fmt.Errorf("read updater thread snapshot: %w", err)
		}
	}
}

func terminateOtherApplicationInstances(applicationExecutable string) error {
	processes, err := otherApplicationProcesses(applicationExecutable)
	if err != nil {
		return err
	}
	defer func() {
		for _, process := range processes {
			_ = windows.CloseHandle(process.handle)
		}
	}()

	var failures []error
	for _, process := range processes {
		if processExited(process.handle) {
			continue
		}
		if err := windows.TerminateProcess(process.handle, 0); err != nil && !processExited(process.handle) {
			failures = append(failures, fmt.Errorf("terminate application process %d: %w", process.pid, err))
		}
	}
	for _, process := range processes {
		result, err := windows.WaitForSingleObject(process.handle, applicationExitWaitMilliseconds)
		if err != nil {
			failures = append(failures, fmt.Errorf("wait for application process %d: %w", process.pid, err))
			continue
		}
		if result != windows.WAIT_OBJECT_0 {
			failures = append(failures, fmt.Errorf("wait for application process %d: result %#x", process.pid, result))
		}
	}
	return errors.Join(failures...)
}

func otherApplicationProcesses(applicationExecutable string) ([]applicationProcess, error) {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, fmt.Errorf("enumerate application processes: %w", err)
	}
	defer windows.CloseHandle(snapshot)

	var processes []applicationProcess
	closeProcesses := func() {
		for _, process := range processes {
			_ = windows.CloseHandle(process.handle)
		}
	}
	entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	if err := windows.Process32First(snapshot, &entry); err != nil {
		if errors.Is(err, windows.ERROR_NO_MORE_FILES) {
			return nil, nil
		}
		return nil, fmt.Errorf("read application process snapshot: %w", err)
	}

	currentPID := uint32(os.Getpid())
	applicationName := filepath.Base(applicationExecutable)
	for {
		if entry.ProcessID != currentPID && strings.EqualFold(syscall.UTF16ToString(entry.ExeFile[:]), applicationName) {
			process, openErr := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, false, entry.ProcessID)
			if errors.Is(openErr, windows.ERROR_INVALID_PARAMETER) {
				openErr = nil
			}
			if openErr != nil {
				closeProcesses()
				return nil, fmt.Errorf("open application process %d: %w", entry.ProcessID, openErr)
			}
			if process != 0 {
				imagePath, pathErr := processImagePath(process)
				if pathErr != nil && !processExited(process) {
					_ = windows.CloseHandle(process)
					closeProcesses()
					return nil, fmt.Errorf("identify application process %d: %w", entry.ProcessID, pathErr)
				}
				if pathErr == nil && sameApplicationExecutable(applicationExecutable, imagePath) {
					processes = append(processes, applicationProcess{handle: process, pid: entry.ProcessID})
				} else {
					_ = windows.CloseHandle(process)
				}
			}
		}

		err = windows.Process32Next(snapshot, &entry)
		if errors.Is(err, windows.ERROR_NO_MORE_FILES) {
			break
		}
		if err != nil {
			closeProcesses()
			return nil, fmt.Errorf("read application process snapshot: %w", err)
		}
	}
	return processes, nil
}

func processImagePath(process windows.Handle) (string, error) {
	buffer := make([]uint16, windows.MAX_LONG_PATH)
	size := uint32(len(buffer))
	result, _, err := queryFullProcessImageNameW.Call(
		uintptr(process),
		0,
		uintptr(unsafe.Pointer(&buffer[0])),
		uintptr(unsafe.Pointer(&size)),
	)
	if result == 0 {
		if err == syscall.Errno(0) {
			err = windows.ERROR_GEN_FAILURE
		}
		return "", err
	}
	return syscall.UTF16ToString(buffer[:size]), nil
}

func sameApplicationExecutable(applicationExecutable, processExecutable string) bool {
	applicationPath := cleanAbsolutePath(applicationExecutable)
	processPath := cleanAbsolutePath(processExecutable)
	if strings.EqualFold(applicationPath, processPath) {
		return true
	}
	applicationInfo, applicationErr := os.Stat(applicationPath)
	processInfo, processErr := os.Stat(processPath)
	return applicationErr == nil && processErr == nil && os.SameFile(applicationInfo, processInfo)
}

func cleanAbsolutePath(path string) string {
	if absolute, err := filepath.Abs(path); err == nil {
		path = absolute
	}
	return filepath.Clean(path)
}

func processExited(process windows.Handle) bool {
	result, err := windows.WaitForSingleObject(process, 0)
	return err == nil && result == windows.WAIT_OBJECT_0
}
