//go:build windows

package updater

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/symp1ex/symmd/internal/settings"
)

func TestParseCheckOutput(t *testing.T) {
	tests := []struct {
		stdout    string
		available bool
		ok        bool
	}{
		{stdout: "true", available: true, ok: true},
		{stdout: " TRUE ", available: true, ok: true},
		{stdout: "false", ok: true},
		{stdout: "unknown"},
		{stdout: "true\nlog"},
	}
	for _, test := range tests {
		available, ok := ParseCheckOutput(test.stdout)
		if available != test.available || ok != test.ok {
			t.Fatalf("ParseCheckOutput(%q) = (%v, %v), want (%v, %v)", test.stdout, available, ok, test.available, test.ok)
		}
	}
}

func TestUpdaterArgumentsMatchSympllateProtocol(t *testing.T) {
	logs := settings.Defaults().Logs
	check := buildUpdaterArgs([]string{"--check"}, logs)
	if check[0] != "--check" || !containsSequence(check, []string{"--logs-level", "warning", "--logs-clear", "2"}) {
		t.Fatalf("check arguments = %v", check)
	}
	upgrade := buildUpdaterArgs(buildUpgradeArgs(`C:\Program Files\Symmd\renamed.exe`), logs)
	want := []string{"--upgrade", "--gui", "--cmd", "renamed.exe start"}
	if !reflect.DeepEqual(upgrade[:len(want)], want) {
		t.Fatalf("upgrade arguments = %v, want prefix %v", upgrade, want)
	}
}

func TestPathsUseUpdaterSMDExecutable(t *testing.T) {
	appDir := t.TempDir()
	updaterDir := filepath.Join(appDir, "updater")
	if err := os.Mkdir(updaterDir, 0o755); err != nil {
		t.Fatal(err)
	}
	updaterPath := filepath.Join(updaterDir, "updater-md.exe")
	if err := os.WriteFile(updaterPath, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	paths, err := pathsForExecutable(filepath.Join(appDir, "symmd.exe"))
	if err != nil {
		t.Fatal(err)
	}
	if paths.UpdaterExe != updaterPath || paths.UpdaterDir != updaterDir || paths.ApplicationExeName != "symmd.exe" {
		t.Fatalf("paths = %#v", paths)
	}
}

func TestMissingUpdaterIsReported(t *testing.T) {
	_, err := pathsForExecutable(filepath.Join(t.TempDir(), "symmd.exe"))
	if err == nil {
		t.Fatal("missing updater was accepted")
	}
}

func TestServiceCheckReturnsAvailableAndStartErrorsSynchronously(t *testing.T) {
	service := newTestService()
	service.startCheck = func(context.Context, Paths, []string) (checkProcess, error) {
		return &fakeCheckProcess{output: processOutput{Stdout: "true"}}, nil
	}
	if result := service.Check(context.Background()); !result.OK || !result.UpdateAvailable {
		t.Fatalf("Check() = %+v", result)
	}

	startErr := errors.New("create process failed")
	service.startCheck = func(context.Context, Paths, []string) (checkProcess, error) { return nil, startErr }
	if result := service.Check(context.Background()); result.OK || result.Message != startErr.Error() {
		t.Fatalf("Check() after start failure = %+v", result)
	}
}

func TestServiceRejectsParallelCheck(t *testing.T) {
	service := newTestService()
	release := make(chan struct{})
	service.startCheck = func(context.Context, Paths, []string) (checkProcess, error) {
		return &fakeCheckProcess{wait: func() { <-release }, output: processOutput{Stdout: "false"}}, nil
	}
	started, first := service.StartCheck(context.Background())
	if !started.OK || first == nil {
		t.Fatalf("first StartCheck() = %+v, %v", started, first)
	}
	second, secondResults := service.StartCheck(context.Background())
	if second.OK || second.Message != "update check is already running" || secondResults != nil {
		t.Fatalf("parallel StartCheck() = %+v, %v", second, secondResults)
	}
	close(release)
	if result := <-first; !result.OK || result.UpdateAvailable {
		t.Fatalf("first result = %+v", result)
	}
}

func TestServiceInstallUsesUpdaterProtocolAndSchedulesExit(t *testing.T) {
	service := newTestService()
	process := &fakeProcess{pid: 42}
	var gotArgs []string
	var scheduled []time.Duration
	service.startUpgrade = func(_ Paths, args []string) (processHandle, error) {
		gotArgs = append([]string(nil), args...)
		return process, nil
	}
	service.scheduleExit = func(after time.Duration) { scheduled = append(scheduled, after) }
	result := service.Install()
	if !result.OK || !process.released || !containsSequence(gotArgs, []string{"--cmd", "symmd.exe start"}) || !reflect.DeepEqual(scheduled, []time.Duration{exitDelay}) {
		t.Fatalf("Install() = %+v, args=%v, released=%t, scheduled=%v", result, gotArgs, process.released, scheduled)
	}
}

func TestAutoCheckGateMissingFreshAndStaleTimestamp(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "last-update-check")
	now := time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC)
	var mutex sync.Mutex
	lock := func(action func() error) error { mutex.Lock(); defer mutex.Unlock(); return action() }
	starts := 0
	start := func() error { starts++; return nil }
	if started, err := tryAutoCheck(statePath, now, lock, start); err != nil || !started {
		t.Fatalf("missing timestamp = %t, %v", started, err)
	}
	if started, err := tryAutoCheck(statePath, now.Add(59*time.Minute), lock, start); err != nil || started {
		t.Fatalf("fresh timestamp = %t, %v", started, err)
	}
	if started, err := tryAutoCheck(statePath, now.Add(time.Hour), lock, start); err != nil || !started {
		t.Fatalf("stale timestamp = %t, %v", started, err)
	}
	if starts != 2 {
		t.Fatalf("start count = %d, want 2", starts)
	}
}

func TestAutoCheckGateRollsBackTimestampWhenCreateProcessFails(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "last-update-check")
	now := time.Now()
	startErr := errors.New("CreateProcess failed")
	if started, err := tryAutoCheck(statePath, now, withAutoCheckLock, func() error { return startErr }); started || !errors.Is(err, startErr) {
		t.Fatalf("failed start = %t, %v", started, err)
	}
	if _, err := os.Stat(statePath); !os.IsNotExist(err) {
		t.Fatalf("failed start left a timestamp: %v", err)
	}
	if started, err := tryAutoCheck(statePath, now, withAutoCheckLock, func() error { return nil }); err != nil || !started {
		t.Fatalf("retry after failed start = %t, %v", started, err)
	}
}

func TestNamedMutexPreventsConcurrentAutomaticStarts(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "last-update-check")
	now := time.Now()
	ready := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int32
	start := func() error {
		if calls.Add(1) == 1 {
			close(ready)
			<-release
		}
		return nil
	}
	results := make(chan bool, 2)
	errorsSeen := make(chan error, 2)
	go func() {
		started, err := tryAutoCheck(statePath, now, withAutoCheckLock, start)
		results <- started
		errorsSeen <- err
	}()
	<-ready
	go func() {
		started, err := tryAutoCheck(statePath, now, withAutoCheckLock, start)
		results <- started
		errorsSeen <- err
	}()
	close(release)
	startedCount := 0
	for range 2 {
		if <-results {
			startedCount++
		}
		if err := <-errorsSeen; err != nil {
			t.Fatal(err)
		}
	}
	if startedCount != 1 || calls.Load() != 1 {
		t.Fatalf("started=%d calls=%d, want 1", startedCount, calls.Load())
	}
}

func TestManualServiceChecksAreNotHourlyThrottled(t *testing.T) {
	service := newTestService()
	var calls int
	service.startCheck = func(context.Context, Paths, []string) (checkProcess, error) {
		calls++
		return &fakeCheckProcess{output: processOutput{Stdout: "false"}}, nil
	}
	for range 2 {
		if result := service.Check(context.Background()); !result.OK {
			t.Fatalf("manual Check() = %+v", result)
		}
	}
	if calls != 2 {
		t.Fatalf("manual check starts = %d, want 2", calls)
	}
}

func newTestService() *Service {
	service := NewService()
	service.resolvePaths = func() (Paths, error) { return testPaths(), nil }
	service.startCheck = func(context.Context, Paths, []string) (checkProcess, error) {
		return &fakeCheckProcess{output: processOutput{Stdout: "false"}}, nil
	}
	service.scheduleExit = func(time.Duration) {}
	return service
}

func testPaths() Paths {
	appDir := filepath.Join(`C:\Program Files`, "Symmd")
	updaterDir := filepath.Join(appDir, "updater")
	return Paths{AppDir: appDir, ApplicationExe: filepath.Join(appDir, "symmd.exe"), ApplicationExeName: "symmd.exe", UpdaterDir: updaterDir, UpdaterExe: filepath.Join(updaterDir, executableName)}
}

func containsSequence(values, sequence []string) bool {
	for index := 0; index+len(sequence) <= len(values); index++ {
		if reflect.DeepEqual(values[index:index+len(sequence)], sequence) {
			return true
		}
	}
	return false
}

type fakeCheckProcess struct {
	output processOutput
	err    error
	wait   func()
}

func (p *fakeCheckProcess) PID() int { return 42 }

func (p *fakeCheckProcess) Wait() (processOutput, error) {
	if p.wait != nil {
		p.wait()
	}
	return p.output, p.err
}

type fakeProcess struct {
	pid      int
	released bool
}

func (p *fakeProcess) PID() int { return p.pid }

func (p *fakeProcess) Release() error {
	p.released = true
	return nil
}
