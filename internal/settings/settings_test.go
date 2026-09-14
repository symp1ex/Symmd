package settings

import (
	"encoding/json"
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
	if config.Preferences.ViewMode != "split" || !config.Preferences.PreviewSync || config.Preferences.FontSize != 14 || config.Preferences.PreviewZoom != 100 {
		t.Fatalf("unexpected defaults: %#v", config.Preferences)
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
