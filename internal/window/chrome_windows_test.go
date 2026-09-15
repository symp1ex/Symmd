//go:build windows

package window

import (
	"math"
	"testing"
)

func TestApplyMonitorWorkAreaUsesMonitorRelativePosition(t *testing.T) {
	info := minMaxInfo{}
	applyMonitorWorkArea(&info, monitorInfo{
		Monitor: rect{Left: -1920, Top: -40, Right: 0, Bottom: 1040},
		Work:    rect{Left: -1920, Top: 0, Right: 0, Bottom: 1000},
	})
	if info.MaxPosition != (point{X: 0, Y: 40}) || info.MaxSize != (point{X: 1920, Y: 1000}) {
		t.Fatalf("unexpected maximized bounds: position=%#v size=%#v", info.MaxPosition, info.MaxSize)
	}
}

func TestCoversRectDistinguishesMaximizedAndRestoredBounds(t *testing.T) {
	work := rect{Left: 0, Top: 0, Right: 2560, Bottom: 1410}
	if !coversRect(rect{Left: -8, Top: -8, Right: 2568, Bottom: 1418}, work) {
		t.Fatal("maximized outer rect does not cover work area")
	}
	if coversRect(rect{Left: 80, Top: 80, Right: 980, Bottom: 780}, work) {
		t.Fatal("restored rect reported as covering work area")
	}
}

func TestIsRectVisibleRejectsInvalidAndOverflowedRects(t *testing.T) {
	if IsRectVisible(0, 0, 0, 480) {
		t.Fatal("zero-width rect reported as visible")
	}
	if IsRectVisible(math.MaxInt32-10, math.MaxInt32-10, 640, 480) {
		t.Fatal("overflowed rect reported as visible")
	}
}
