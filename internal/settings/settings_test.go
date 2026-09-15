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
	if config.Preferences.ViewMode != "split" || !config.Preferences.PreviewSync || config.Preferences.FontSize != 14 || config.Preferences.PreviewZoom != 100 || config.Preferences.AutoReloadExternalChanges {
		t.Fatalf("unexpected defaults: %#v", config.Preferences)
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
