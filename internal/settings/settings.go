package settings

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

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

type Config struct {
	Window      WindowState `json:"window"`
	Preferences Preferences `json:"preferences"`
}

func Defaults() Config {
	return Config{Preferences: Preferences{Theme: "dark", FontSize: 14, WordWrap: true, ViewMode: "split", PreviewSync: true, PreviewZoom: 100, Split: 50, AutoReloadExternalChanges: false}}
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
	return config, nil
}

func Save(config Config) error {
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
