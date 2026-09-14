package settings

import "testing"

func TestWindowStateJSONFieldsRemainStable(t *testing.T) {
	state := WindowState{X: 1, Y: 2, Width: 900, Height: 700}
	if state.Width < 640 || state.Height < 480 {
		t.Fatal("invalid test window state")
	}
}

func TestDefaults(t *testing.T) {
	config := Defaults()
	if config.Preferences.ViewMode != "split" || !config.Preferences.PreviewSync || config.Preferences.FontSize != 14 {
		t.Fatalf("unexpected defaults: %#v", config.Preferences)
	}
}

func TestNormalizePreferencesRejectsInvalidRanges(t *testing.T) {
	preferences := NormalizePreferences(Preferences{Theme: "unknown", FontSize: 100, ViewMode: "other", Split: -1})
	if preferences.Theme != "dark" || preferences.FontSize != 14 || preferences.ViewMode != "split" || preferences.Split != 50 {
		t.Fatalf("unexpected normalized preferences: %#v", preferences)
	}
}
