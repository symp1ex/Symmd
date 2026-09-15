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

func TestRestoreRectKeepsNormalAndSnappedBounds(t *testing.T) {
	current := rect{Left: -1920, Top: 40, Right: -960, Bottom: 1040}
	restored, ok := restoreRect(current, false, rect{}, false)
	if !ok || restored != current {
		t.Fatalf("restoreRect() = %#v, %t", restored, ok)
	}
}

func TestRestoreRectUsesMonitorWorkAreaForMaximizedBounds(t *testing.T) {
	current := rect{Left: -1928, Top: -8, Right: 8, Bottom: 1088}
	work := rect{Left: -1920, Top: 40, Right: 0, Bottom: 1080}
	restored, ok := restoreRect(current, true, work, true)
	if !ok || restored != work {
		t.Fatalf("restoreRect() = %#v, %t, want %#v, true", restored, ok, work)
	}
}

func TestRestoreRectRejectsMaximizedBoundsWithoutMonitorWorkArea(t *testing.T) {
	if restored, ok := restoreRect(rect{Left: -8, Top: -8, Right: 1928, Bottom: 1088}, true, rect{}, false); ok || restored != (rect{}) {
		t.Fatalf("restoreRect() = %#v, %t", restored, ok)
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
