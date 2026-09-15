package settings

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	LogLevelDebug   = "debug"
	LogLevelInfo    = "info"
	LogLevelWarning = "warning"
	LogLevelError   = "error"
)

type SelectSetting struct {
	Active string   `json:"active"`
	List   []string `json:"list"`
}

func (s *SelectSetting) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 {
		return errors.New("empty select value")
	}
	if trimmed[0] == '"' {
		var active string
		if err := json.Unmarshal(trimmed, &active); err != nil {
			return err
		}
		s.Active = active
		return nil
	}
	if trimmed[0] != '{' {
		return errors.New("select setting must be a string or an object with active and list")
	}
	type selectSettingAlias SelectSetting
	next := selectSettingAlias(*s)
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&next); err != nil {
		return err
	}
	*s = SelectSetting(next)
	return nil
}

type WindowState struct {
	X      int32 `json:"x"`
	Y      int32 `json:"y"`
	Width  int32 `json:"width"`
	Height int32 `json:"height"`
}

type Preferences struct {
	Theme                     string  `json:"theme"`
	FontSize                  int     `json:"fontSize"`
	WordWrap                  bool    `json:"wordWrap"`
	ViewMode                  string  `json:"viewMode"`
	PreviewSync               bool    `json:"previewSync"`
	PreviewZoom               int     `json:"previewZoom"`
	Split                     float64 `json:"split"`
	AutoReloadExternalChanges bool    `json:"autoReloadExternalChanges"`
}

type UpdaterConfig struct {
	Enabled bool `json:"enabled"`
}

type LogsConfig struct {
	LogLevel  SelectSetting `json:"log_level"`
	StoreDays int           `json:"store_days"`
}

type Config struct {
	Window      WindowState   `json:"window"`
	Preferences Preferences   `json:"preferences"`
	Updater     UpdaterConfig `json:"updater"`
	Logs        LogsConfig    `json:"logs"`
}

func Defaults() Config {
	return Config{
		Preferences: Preferences{Theme: "dark", FontSize: 14, WordWrap: true, ViewMode: "split", PreviewSync: true, PreviewZoom: 100, Split: 50, AutoReloadExternalChanges: false},
		Updater:     UpdaterConfig{Enabled: true},
		Logs:        LogsConfig{LogLevel: SelectSetting{Active: LogLevelWarning, List: []string{LogLevelDebug, LogLevelInfo, LogLevelWarning, LogLevelError}}, StoreDays: 2},
	}
}

func NormalizePreferences(preferences Preferences) Preferences {
	defaults := Defaults().Preferences
	if preferences.Theme != "dark" && preferences.Theme != "light" {
		preferences.Theme = defaults.Theme
	}
	if preferences.FontSize < 10 || preferences.FontSize > 32 {
		preferences.FontSize = defaults.FontSize
	}
	if preferences.ViewMode != "editor" && preferences.ViewMode != "split" && preferences.ViewMode != "preview" {
		preferences.ViewMode = defaults.ViewMode
	}
	if preferences.PreviewZoom < 50 || preferences.PreviewZoom > 200 {
		preferences.PreviewZoom = defaults.PreviewZoom
	}
	if preferences.Split < 25 || preferences.Split > 75 {
		preferences.Split = defaults.Split
	}
	return preferences
}

func Path() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("locate user configuration: %w", err)
	}
	return filepath.Join(dir, "symmd", "settings.json"), nil
}

func Load() (Config, error) {
	path, err := Path()
	if err != nil {
		return Config{}, err
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return Defaults(), nil
	}
	if err != nil {
		return Config{}, fmt.Errorf("read settings: %w", err)
	}
	config := Defaults()
	if err := json.Unmarshal(data, &config); err != nil {
		return Config{}, fmt.Errorf("parse settings: %w", err)
	}
	config.Preferences = NormalizePreferences(config.Preferences)
	if err := normalizeAndValidateLogs(&config.Logs); err != nil {
		return Config{}, err
	}
	return config, nil
}

func Save(config Config) error {
	if err := normalizeAndValidateLogs(&config.Logs); err != nil {
		return err
	}
	path, err := Path()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create settings directory: %w", err)
	}
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return fmt.Errorf("encode settings: %w", err)
	}
	if err := os.WriteFile(path, append(data, '\n'), 0o600); err != nil {
		return fmt.Errorf("write settings: %w", err)
	}
	return nil
}

func normalizeAndValidateLogs(logs *LogsConfig) error {
	logs.LogLevel.Active = strings.ToLower(strings.TrimSpace(logs.LogLevel.Active))
	for index, level := range logs.LogLevel.List {
		logs.LogLevel.List[index] = strings.ToLower(strings.TrimSpace(level))
	}
	if logs.StoreDays <= 0 {
		return errors.New("logs.store_days must be greater than zero")
	}
	if !validLogLevel(logs.LogLevel.Active) {
		return errors.New("logs.log_level.active must be debug, info, warning, or error")
	}
	if len(logs.LogLevel.List) == 0 {
		return errors.New("logs.log_level.list cannot be empty")
	}
	foundActive := false
	for _, level := range logs.LogLevel.List {
		if !validLogLevel(level) {
			return fmt.Errorf("logs.log_level.list contains unknown value %q", level)
		}
		foundActive = foundActive || level == logs.LogLevel.Active
	}
	if !foundActive {
		return errors.New("logs.log_level.active must be present in list")
	}
	return nil
}

func validLogLevel(level string) bool {
	switch level {
	case LogLevelDebug, LogLevelInfo, LogLevelWarning, LogLevelError:
		return true
	default:
		return false
	}
}
