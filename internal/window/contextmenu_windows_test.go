//go:build windows

package window

import "testing"

func TestContextMenuItemsRespectEditableAndLinkContexts(t *testing.T) {
	editor := contextMenuItems(ContextMenuOptions{Editable: true, HasSelection: true, CanSelectAll: true, CanPaste: true})
	if got := contextMenuLabels(editor); got != "Cut|Copy|Paste|Select All" {
		t.Fatalf("editor items = %q", got)
	}
	if !editor[2].enabled {
		t.Fatal("Paste is disabled with Unicode text on the clipboard")
	}
	preview := contextMenuItems(ContextMenuOptions{CanSelectAll: true, Link: true, CanSaveLink: true})
	if got := contextMenuLabels(preview); got != "Save link as…|Copy link|-|Copy|Select All" {
		t.Fatalf("preview link items = %q", got)
	}
	if preview[3].enabled {
		t.Fatal("preview Copy is enabled without a selection")
	}
	if !preview[0].enabled {
		t.Fatal("Save link as is disabled for a saveable link")
	}
}

func TestContextMenuItemsDisableUnsavableLink(t *testing.T) {
	items := contextMenuItems(ContextMenuOptions{Link: true})
	if items[0].label != "Save link as…" || items[0].enabled {
		t.Fatalf("unsavable link item = %+v", items[0])
	}
	if !items[1].enabled {
		t.Fatal("Copy link is disabled")
	}
}

func contextMenuLabels(items []contextMenuItem) string {
	result := ""
	for _, item := range items {
		if result != "" {
			result += "|"
		}
		if item.separator {
			result += "-"
		} else {
			result += item.label
		}
	}
	return result
}
