package settings

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWindowStateJSONFieldsRemainStable(t *testing.T) {
	state := WindowState{X: 1, Y: 2, Width: 900, Height: 700}
	if state.Width < 640 || state.Height < 480 {
		t.Fatal("invalid test window state")
	}
}

func TestDefaults(t *testing.T) {
	config := Defaults()
	if config.Preferences.ViewMode != "split" || !config.Preferences.PreviewSync || config.Preferences.FontSize != 14 || config.Preferences.PreviewZoom != 100 || config.Preferences.AutoReloadExternalChanges {
		t.Fatalf("unexpected defaults: %#v", config.Preferences)
	}
	if !config.Updater.Enabled {
		t.Fatal("default updater is disabled")
	}
	if config.Logs.LogLevel.Active != LogLevelWarning || config.Logs.StoreDays != 2 {
		t.Fatalf("unexpected log defaults: %#v", config.Logs)
	}
	if got := strings.Join(config.Logs.LogLevel.List, ","); got != "debug,info,warning,error" {
		t.Fatalf("unexpected log levels: %q", got)
	}
}

func TestLoadLegacySettingsAddsLoggerAndUpdaterDefaults(t *testing.T) {
	root := t.TempDir()
	t.Setenv("APPDATA", root)
	directory := filepath.Join(root, "symmd")
	if err := os.MkdirAll(directory, 0o755); err != nil {
		t.Fatal(err)
	}
	legacy := `{"window":{"x":1,"y":2,"width":900,"height":700},"preferences":{"theme":"light","fontSize":16,"wordWrap":false,"viewMode":"preview","previewSync":false,"previewZoom":110,"split":60,"autoReloadExternalChanges":true}}`
	if err := os.WriteFile(filepath.Join(directory, "settings.json"), []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	config, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if config.Window.Width != 900 || config.Preferences.Theme != "light" || !config.Preferences.AutoReloadExternalChanges {
		t.Fatalf("legacy values were not preserved: %#v", config)
	}
	if !config.Updater.Enabled || config.Logs.LogLevel.Active != LogLevelWarning || config.Logs.StoreDays != 2 {
		t.Fatalf("new defaults were not applied: %#v", config)
	}
}

func TestUpdaterDisabledRoundTripsWithoutChangingOtherSettings(t *testing.T) {
	root := t.TempDir()
	t.Setenv("APPDATA", root)
	config := Defaults()
	config.Window = WindowState{X: 3, Y: 4, Width: 920, Height: 710}
	config.Preferences.Theme = "light"
	config.Logs.LogLevel.Active = LogLevelDebug
	config.Updater.Enabled = false
	if err := Save(config); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Updater.Enabled || loaded.Window != config.Window || loaded.Preferences.Theme != "light" || loaded.Logs.LogLevel.Active != LogLevelDebug {
		t.Fatalf("settings round trip changed unrelated values: %#v", loaded)
	}
	data, err := os.ReadFile(filepath.Join(root, "symmd", "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"updater": {`) || !strings.Contains(string(data), `"logs": {`) || !strings.Contains(string(data), `"log_level": {`) || !strings.Contains(string(data), `"store_days": 2`) {
		t.Fatalf("unexpected settings JSON: %s", data)
	}
}

func TestMissingAutoReloadExternalChangesUsesDefault(t *testing.T) {
	config := Defaults()
	if err := json.Unmarshal([]byte(`{"preferences":{"theme":"light","fontSize":16,"wordWrap":true,"viewMode":"preview","previewSync":true,"previewZoom":110,"split":60}}`), &config); err != nil {
		t.Fatal(err)
	}
	config.Preferences = NormalizePreferences(config.Preferences)
	if config.Preferences.AutoReloadExternalChanges {
		t.Fatalf("unexpected migrated preferences: %#v", config.Preferences)
	}
}

func TestAutoReloadExternalChangesJSONRoundTrip(t *testing.T) {
	preferences := Defaults().Preferences
	preferences.AutoReloadExternalChanges = true
	data, err := json.Marshal(preferences)
	if err != nil {
		t.Fatal(err)
	}
	var decoded Preferences
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if !decoded.AutoReloadExternalChanges {
		t.Fatalf("unexpected decoded preferences: %#v", decoded)
	}
}

func TestNormalizePreferencesRejectsInvalidRanges(t *testing.T) {
	preferences := NormalizePreferences(Preferences{Theme: "unknown", FontSize: 100, ViewMode: "other", PreviewZoom: 300, Split: -1})
	if preferences.Theme != "dark" || preferences.FontSize != 14 || preferences.ViewMode != "split" || preferences.PreviewZoom != 100 || preferences.Split != 50 {
		t.Fatalf("unexpected normalized preferences: %#v", preferences)
	}
}

func TestMissingPreviewZoomUsesDefault(t *testing.T) {
	config := Defaults()
	if err := json.Unmarshal([]byte(`{"preferences":{"theme":"light","fontSize":16,"wordWrap":true,"viewMode":"preview","previewSync":true,"split":60}}`), &config); err != nil {
		t.Fatal(err)
	}
	config.Preferences = NormalizePreferences(config.Preferences)
	if config.Preferences.PreviewZoom != 100 || config.Preferences.Theme != "light" || config.Preferences.Split != 60 {
		t.Fatalf("unexpected migrated preferences: %#v", config.Preferences)
	}
}
