package logger

import (
	"bytes"
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPlainHandlerFormatAndLevel(t *testing.T) {
	var output bytes.Buffer
	handler := NewPlainHandler(&output, slog.LevelWarn)
	if handler.Enabled(context.Background(), slog.LevelInfo) {
		t.Fatal("info level unexpectedly enabled")
	}
	if !handler.Enabled(context.Background(), slog.LevelWarn) || !handler.Enabled(context.Background(), slog.LevelError) {
		t.Fatal("warn or error level unexpectedly disabled")
	}
	record := slog.NewRecord(time.Date(2026, 8, 5, 12, 34, 56, 0, time.Local), slog.LevelWarn, "message", 0)
	if err := handler.Handle(context.Background(), record); err != nil {
		t.Fatal(err)
	}
	if got, want := output.String(), "[2026-08-05 12:34:56,000] [WARN] message\n"; got != want {
		t.Fatalf("log line = %q, want %q", got, want)
	}
}

func TestLoggerFiltersConfiguredLevel(t *testing.T) {
	var output bytes.Buffer
	value := Logger{slog.New(NewPlainHandler(&output, levelFromString("warning")))}
	value.Debugf("debug")
	value.Infof("info")
	value.Warnf("warning")
	value.Errorf("error")
	if got := output.String(); strings.Contains(got, "debug") || strings.Contains(got, "info") || !strings.Contains(got, "[WARN] warning") || !strings.Contains(got, "[ERROR] error") {
		t.Fatalf("unexpected filtered output: %q", got)
	}
}

func TestRotatingWriterRotatesPreviousDay(t *testing.T) {
	directory := useTestLogDirectory(t, 2)
	path := filepath.Join(directory, "symmd.log")
	if err := os.WriteFile(path, []byte("previous"), 0o644); err != nil {
		t.Fatal(err)
	}
	previousDay := time.Now().AddDate(0, 0, -1)
	if err := os.Chtimes(path, previousDay, previousDay); err != nil {
		t.Fatal(err)
	}

	writer := NewRotatingWriter("symmd")
	t.Cleanup(func() { _ = writer.file.Close() })
	rotated := filepath.Join(directory, "symmd.log."+previousDay.Format("2006-01-02"))
	if data, err := os.ReadFile(rotated); err != nil || string(data) != "previous" {
		t.Fatalf("rotated log = %q, %v", data, err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("current log was not created: %v", err)
	}
}

func TestRotatingWriterRemovesExpiredLogs(t *testing.T) {
	directory := useTestLogDirectory(t, 2)
	oldPath := filepath.Join(directory, "symmd.log.2026-01-01")
	recentPath := filepath.Join(directory, "symmd.log.2026-01-02")
	for _, path := range []string{oldPath, recentPath} {
		if err := os.WriteFile(path, []byte("log"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	oldTime := time.Now().AddDate(0, 0, -3)
	recentTime := time.Now().AddDate(0, 0, -1)
	if err := os.Chtimes(oldPath, oldTime, oldTime); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(recentPath, recentTime, recentTime); err != nil {
		t.Fatal(err)
	}

	writer := NewRotatingWriter("symmd")
	t.Cleanup(func() { _ = writer.file.Close() })
	if _, err := os.Stat(oldPath); !os.IsNotExist(err) {
		t.Fatalf("expired log was not removed: %v", err)
	}
	if _, err := os.Stat(recentPath); err != nil {
		t.Fatalf("recent log was removed: %v", err)
	}
}

func TestRotatingWriterPanicsWhenLogDirectoryCannotBeCreated(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "not-a-directory")
	if err := os.WriteFile(file, []byte("file"), 0o600); err != nil {
		t.Fatal(err)
	}
	useTestLogDirectory(t, 2)
	logDir = filepath.Join(file, "logs")
	defer func() {
		if recover() == nil {
			t.Fatal("NewRotatingWriter did not preserve sympllate panic behavior")
		}
	}()
	NewRotatingWriter("symmd")
}

func useTestLogDirectory(t *testing.T, days int) string {
	t.Helper()
	mu.Lock()
	oldDir, oldDays, oldLevel, oldLoggers, oldSymmd := logDir, retainDays, logLevel, loggers, Symmd
	logDir = t.TempDir()
	retainDays = days
	logLevel = "warning"
	loggers = make(map[string]*slog.Logger)
	mu.Unlock()
	t.Cleanup(func() {
		mu.Lock()
		logDir, retainDays, logLevel, loggers, Symmd = oldDir, oldDays, oldLevel, oldLoggers, oldSymmd
		mu.Unlock()
	})
	return logDir
}
