package logger

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"

	"github.com/symp1ex/symmd/internal/settings"
)

var (
	loggers    = make(map[string]*slog.Logger)
	mu         sync.Mutex
	logDir     string
	retainDays = 2
	logLevel   = "warning"
	Symmd      Logger
)

type Logger struct {
	*slog.Logger
}

func Configure(cfg settings.LogsConfig) {
	configPath, err := settings.Path()
	if err != nil {
		panic(err)
	}
	mu.Lock()
	logDir = filepath.Join(filepath.Dir(configPath), "logs")
	retainDays = cfg.StoreDays
	logLevel = cfg.LogLevel.Active
	loggers = make(map[string]*slog.Logger)
	mu.Unlock()

	Symmd = Logger{Get("symmd")}
}

func Directory() string {
	mu.Lock()
	defer mu.Unlock()
	if logDir == "" {
		configPath, err := settings.Path()
		if err != nil {
			return ""
		}
		logDir = filepath.Join(filepath.Dir(configPath), "logs")
	}
	return logDir
}

func levelFromString(level string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(level)) {
	case settings.LogLevelDebug:
		return slog.LevelDebug
	case settings.LogLevelInfo:
		return slog.LevelInfo
	case settings.LogLevelWarning:
		return slog.LevelWarn
	case settings.LogLevelError:
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

func (l Logger) Printf(format string, args ...any) { l.Infof(format, args...) }

func (l Logger) Infof(format string, args ...any) { l.logf(slog.LevelInfo, format, args...) }

func (l Logger) Debugf(format string, args ...any) { l.logf(slog.LevelDebug, format, args...) }

func (l Logger) Warnf(format string, args ...any) { l.logf(slog.LevelWarn, format, args...) }

func (l Logger) Errorf(format string, args ...any) { l.logf(slog.LevelError, format, args...) }

func (l Logger) Writer() io.Writer {
	if l.Logger == nil {
		return io.Discard
	}
	return slog.NewLogLogger(l.Handler(), slog.LevelInfo).Writer()
}

func (l Logger) logf(level slog.Level, format string, args ...any) {
	if l.Logger == nil {
		return
	}
	ctx := context.Background()
	if l.Enabled(ctx, level) {
		l.Log(ctx, level, fmt.Sprintf(format, args...))
	}
}

func Get(name string) *slog.Logger {
	mu.Lock()
	defer mu.Unlock()

	if existing, ok := loggers[name]; ok {
		return existing
	}
	if logDir == "" {
		configPath, err := settings.Path()
		if err != nil {
			panic(err)
		}
		logDir = filepath.Join(filepath.Dir(configPath), "logs")
	}
	writer := NewRotatingWriter(name)
	result := slog.New(NewPlainHandler(writer, levelFromString(logLevel)))
	loggers[name] = result
	return result
}
