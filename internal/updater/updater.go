package updater

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/symp1ex/symmd/internal/logger"
	"github.com/symp1ex/symmd/internal/settings"
)

const (
	executableName = "updater-smd.exe"
	defaultTimeout = 2 * time.Minute
	exitDelay      = 2 * time.Second
)

var (
	checkArgs      = []string{"--check"}
	DefaultService = NewService()
)

type Paths struct {
	AppDir             string
	ApplicationExe     string
	ApplicationExeName string
	UpdaterDir         string
	UpdaterExe         string
}

type CheckResult struct {
	OK              bool   `json:"ok"`
	UpdateAvailable bool   `json:"updateAvailable"`
	Message         string `json:"message,omitempty"`
}

type InstallResult struct {
	OK      bool   `json:"ok"`
	Message string `json:"message,omitempty"`
}

type processOutput struct {
	Stdout string
	Stderr string
}

type checkProcess interface {
	PID() int
	Wait() (processOutput, error)
}

type processHandle interface {
	PID() int
	Kill() error
	Resume() error
	Release() error
}

type Logger interface {
	Debugf(format string, args ...any)
	Infof(format string, args ...any)
	Warnf(format string, args ...any)
	Errorf(format string, args ...any)
}

type noopLogger struct{}

func (noopLogger) Debugf(string, ...any) {}
func (noopLogger) Infof(string, ...any)  {}
func (noopLogger) Warnf(string, ...any)  {}
func (noopLogger) Errorf(string, ...any) {}

type Service struct {
	mu       sync.Mutex
	checking bool
	logs     settings.LogsConfig

	timeout      time.Duration
	resolvePaths func() (Paths, error)
	startCheck   func(context.Context, Paths, []string) (checkProcess, error)
	startUpgrade func(Paths, []string) (processHandle, error)
	stopOthers   func(string) error
	scheduleExit func(time.Duration)
}

var logSink Logger = noopLogger{}

func NewService() *Service {
	return &Service{
		logs:         settings.Defaults().Logs,
		timeout:      defaultTimeout,
		resolvePaths: ResolvePaths,
		startCheck:   startCheckProcess,
		startUpgrade: startUpgradeProcess,
		stopOthers:   terminateOtherApplicationInstances,
		scheduleExit: scheduleApplicationExit,
	}
}

func SetLogger(value Logger) {
	if value == nil {
		logSink = noopLogger{}
		return
	}
	logSink = value
}

func (s *Service) SetLogs(logs settings.LogsConfig) {
	s.mu.Lock()
	s.logs = logs
	s.mu.Unlock()
}

func ResolvePaths() (Paths, error) {
	applicationExecutable, err := resolveApplicationExecutable()
	if err != nil {
		return Paths{}, err
	}
	return pathsForExecutable(applicationExecutable)
}

func pathsForExecutable(applicationExecutable string) (Paths, error) {
	appDir := filepath.Dir(applicationExecutable)
	applicationExeName := filepath.Base(applicationExecutable)
	updaterDir := filepath.Join(appDir, "updater")
	updaterExe := filepath.Join(updaterDir, executableName)

	logSink.Debugf("[Updater] Application executable: %s", applicationExecutable)
	logSink.Debugf("[Updater] Application executable name: %s", applicationExeName)
	logSink.Debugf("[Updater] Updater directory: %s", updaterDir)
	logSink.Debugf("[Updater] Updater executable: %s", updaterExe)

	if info, statErr := os.Stat(updaterDir); statErr != nil {
		logSink.Errorf("[Updater] Updater directory is unavailable: dir=%s error=%v", updaterDir, statErr)
		return Paths{}, fmt.Errorf("check updater directory %s: %w", updaterDir, statErr)
	} else if !info.IsDir() {
		logSink.Errorf("[Updater] Updater path is not a directory: dir=%s", updaterDir)
		return Paths{}, fmt.Errorf("updater path is not a directory: %s", updaterDir)
	}

	if info, statErr := os.Stat(updaterExe); statErr != nil {
		logSink.Errorf("[Updater] Updater executable is unavailable: exe=%s error=%v", updaterExe, statErr)
		return Paths{}, fmt.Errorf("check updater executable %s: %w", updaterExe, statErr)
	} else if info.IsDir() {
		logSink.Errorf("[Updater] Updater executable path is a directory: exe=%s", updaterExe)
		return Paths{}, fmt.Errorf("updater executable path is a directory: %s", updaterExe)
	}

	return Paths{
		AppDir:             appDir,
		ApplicationExe:     applicationExecutable,
		ApplicationExeName: applicationExeName,
		UpdaterDir:         updaterDir,
		UpdaterExe:         updaterExe,
	}, nil
}

func resolveApplicationExecutable() (string, error) {
	applicationExecutable, err := os.Executable()
	if err != nil {
		logSink.Errorf("[Updater] Failed to resolve application executable path: %v", err)
		return "", fmt.Errorf("resolve application executable: %w", err)
	}
	if resolvedExecutable, resolveErr := filepath.EvalSymlinks(applicationExecutable); resolveErr == nil {
		applicationExecutable = resolvedExecutable
	} else {
		logSink.Warnf("[Updater] Failed to resolve application executable symlinks; using original path: exe=%s error=%v", applicationExecutable, resolveErr)
	}
	return applicationExecutable, nil
}

func (s *Service) StartCheck(ctx context.Context) (CheckResult, <-chan CheckResult) {
	if ctx == nil {
		ctx = context.Background()
	}
	if !s.beginCheck() {
		logSink.Warnf("[Updater] Update check skipped because another check is already running")
		return CheckResult{Message: "update check is already running"}, nil
	}

	paths, err := s.resolvePaths()
	if err != nil {
		s.endCheck()
		return CheckResult{Message: err.Error()}, nil
	}
	args := buildUpdaterArgs(checkArgs, s.logsConfig())
	logSink.Infof("[Updater] Starting update check")
	logSink.Debugf("[Updater] Updater executable: %s", paths.UpdaterExe)
	logSink.Debugf("[Updater] Updater working directory: %s", paths.UpdaterDir)
	logSink.Debugf("[Updater] Check arguments: %v", args)

	checkCtx, cancel := context.WithTimeout(ctx, s.timeout)
	process, err := s.startCheck(checkCtx, paths, args)
	if err != nil {
		cancel()
		s.endCheck()
		return CheckResult{Message: err.Error()}, nil
	}

	results := make(chan CheckResult, 1)
	go func() {
		defer close(results)
		defer cancel()
		defer s.endCheck()
		output, waitErr := process.Wait()
		logProcessOutput(output)
		result := parseCheckResult(checkCtx, s.timeout, output, waitErr)
		results <- result
	}()
	return CheckResult{OK: true, Message: "update check started"}, results
}

func (s *Service) Check(ctx context.Context) CheckResult {
	started, results := s.StartCheck(ctx)
	if results == nil {
		return started
	}
	return <-results
}

func parseCheckResult(ctx context.Context, timeout time.Duration, output processOutput, err error) CheckResult {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		logSink.Errorf("[Updater] Update check timed out after %s", timeout)
		return CheckResult{Message: "update check timed out"}
	}
	if err != nil {
		logSink.Errorf("[Updater] Update check failed: %v", err)
		return CheckResult{Message: err.Error()}
	}
	available, ok := ParseCheckOutput(output.Stdout)
	if !ok {
		logSink.Warnf("[Updater] Unknown update check response: stdout=%q", output.Stdout)
		return CheckResult{Message: "unknown updater response"}
	}
	logSink.Infof("[Updater] Update check completed: update_available=%t", available)
	return CheckResult{OK: true, UpdateAvailable: available}
}

func (s *Service) Install() InstallResult {
	paths, err := s.resolvePaths()
	if err != nil {
		return InstallResult{Message: err.Error()}
	}

	restartCommand := paths.ApplicationExeName + " start"
	args := buildUpdaterArgs(buildUpgradeArgs(paths.ApplicationExeName), s.logsConfig())
	logSink.Infof("[Updater] Starting update installation")
	logSink.Debugf("[Updater] Updater executable: %s", paths.UpdaterExe)
	logSink.Debugf("[Updater] Updater working directory: %s", paths.UpdaterDir)
	logSink.Debugf("[Updater] Restart command: %s", restartCommand)
	logSink.Debugf("[Updater] Upgrade arguments: %v", args)

	process, err := s.startUpgrade(paths, args)
	if err != nil {
		logSink.Errorf("[Updater] Failed to start update installation: %v", err)
		return InstallResult{Message: err.Error()}
	}
	pid := process.PID()
	logSink.Debugf("[Updater] Update installation process started: pid=%d", pid)
	if err := s.stopOthers(paths.ApplicationExe); err != nil {
		logSink.Errorf("[Updater] Failed to stop other application instances: %v", err)
		if killErr := process.Kill(); killErr != nil {
			logSink.Errorf("[Updater] Failed to stop update installation process: pid=%d error=%v", pid, killErr)
		}
		if releaseErr := process.Release(); releaseErr != nil {
			logSink.Errorf("[Updater] Failed to release aborted update installation process handle: pid=%d error=%v", pid, releaseErr)
		}
		return InstallResult{Message: err.Error()}
	}
	if err := process.Resume(); err != nil {
		logSink.Errorf("[Updater] Failed to resume update installation process: pid=%d error=%v", pid, err)
		if killErr := process.Kill(); killErr != nil {
			logSink.Errorf("[Updater] Failed to stop update installation process: pid=%d error=%v", pid, killErr)
		}
		if releaseErr := process.Release(); releaseErr != nil {
			logSink.Errorf("[Updater] Failed to release aborted update installation process handle: pid=%d error=%v", pid, releaseErr)
		}
		return InstallResult{Message: err.Error()}
	}
	if err := process.Release(); err != nil {
		logSink.Errorf("[Updater] Failed to release update installation process handle: pid=%d error=%v", pid, err)
		return InstallResult{Message: err.Error()}
	}

	logSink.Infof("[Updater] Update installation started successfully: pid=%d", pid)
	logSink.Infof("[Updater] Application exit scheduled after %s", exitDelay)
	s.scheduleExit(exitDelay)
	return InstallResult{OK: true}
}

func ParseCheckOutput(stdout string) (available bool, ok bool) {
	switch strings.ToLower(strings.TrimSpace(stdout)) {
	case "true":
		return true, true
	case "false":
		return false, true
	default:
		return false, false
	}
}

func buildUpgradeArgs(applicationExecutable string) []string {
	normalizedExecutable := strings.ReplaceAll(applicationExecutable, `\`, string(os.PathSeparator))
	return []string{"--upgrade", "--gui", "--cmd", filepath.Base(normalizedExecutable) + " start"}
}

func buildUpdaterArgs(base []string, logs settings.LogsConfig) []string {
	args := make([]string, 0, len(base)+6)
	args = append(args, base...)
	return append(args,
		"--logs-dir", logger.Directory(),
		"--logs-level", logs.LogLevel.Active,
		"--logs-clear", strconv.Itoa(logs.StoreDays),
	)
}

func (s *Service) beginCheck() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.checking {
		return false
	}
	s.checking = true
	return true
}

func (s *Service) endCheck() {
	s.mu.Lock()
	s.checking = false
	s.mu.Unlock()
}

func (s *Service) logsConfig() settings.LogsConfig {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.logs
}

type runningCheck struct {
	cmd    *exec.Cmd
	stdout *bytes.Buffer
	stderr *bytes.Buffer
}

func startCheckProcess(ctx context.Context, paths Paths, args []string) (checkProcess, error) {
	cmd := exec.CommandContext(ctx, paths.UpdaterExe, args...)
	cmd.Dir = paths.UpdaterDir
	stdout := &bytes.Buffer{}
	stderr := &bytes.Buffer{}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		logSink.Errorf("[Updater] Failed to start check process: exe=%s dir=%s args=%v error=%v", paths.UpdaterExe, paths.UpdaterDir, args, err)
		return nil, err
	}
	logSink.Debugf("[Updater] Check process started: pid=%d", cmd.Process.Pid)
	return &runningCheck{cmd: cmd, stdout: stdout, stderr: stderr}, nil
}

func (p *runningCheck) PID() int {
	if p == nil || p.cmd == nil || p.cmd.Process == nil {
		return 0
	}
	return p.cmd.Process.Pid
}

func (p *runningCheck) Wait() (processOutput, error) {
	pid := p.PID()
	err := p.cmd.Wait()
	output := processOutput{Stdout: p.stdout.String(), Stderr: p.stderr.String()}
	if err != nil {
		logSink.Errorf("[Updater] Check process completed with error: pid=%d error=%v", pid, err)
		return output, err
	}
	logSink.Debugf("[Updater] Check process completed successfully: pid=%d", pid)
	return output, nil
}

func startUpgradeProcess(paths Paths, args []string) (processHandle, error) {
	cmd := exec.Command(paths.UpdaterExe, args...)
	cmd.Dir = paths.UpdaterDir
	setDetachedProcessAttributes(cmd)
	if err := cmd.Start(); err != nil {
		logSink.Errorf("[Updater] Failed to start upgrade process: exe=%s dir=%s args=%v error=%v", paths.UpdaterExe, paths.UpdaterDir, args, err)
		return nil, err
	}
	return commandProcess{process: cmd.Process}, nil
}

func logProcessOutput(output processOutput) {
	logSink.Debugf("[Updater] Check stdout: %q", output.Stdout)
	if strings.TrimSpace(output.Stderr) != "" {
		logSink.Warnf("[Updater] Check stderr: %q", output.Stderr)
	}
}

func scheduleApplicationExit(after time.Duration) {
	go func() {
		time.Sleep(after)
		logSink.Infof("[Updater] Exiting application after update installation start")
		os.Exit(0)
	}()
}

type commandProcess struct{ process *os.Process }

func (p commandProcess) PID() int {
	if p.process == nil {
		return 0
	}
	return p.process.Pid
}

func (p commandProcess) Kill() error {
	if p.process == nil {
		return nil
	}
	return p.process.Kill()
}

func (p commandProcess) Resume() error {
	return resumeProcess(p.PID())
}

func (p commandProcess) Release() error {
	if p.process == nil {
		return nil
	}
	return p.process.Release()
}
