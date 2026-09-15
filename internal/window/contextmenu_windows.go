//go:build windows

package window

import (
	"errors"
	"fmt"
	"syscall"
	"unsafe"
)

const (
	menuCut = iota + 1
	menuCopy
	menuPaste
	menuSelectAll
	menuSaveLink
	menuCopyLink

	mfGray         = 0x00000001
	mfSeparator    = 0x00000800
	tpmRightButton = 0x0002
	tpmReturnCmd   = 0x0100
	wmNull         = 0x0000
	cfUnicodeText  = 13
)

type ContextMenuOptions struct {
	Editable     bool `json:"editable"`
	HasSelection bool `json:"hasSelection"`
	CanSelectAll bool `json:"canSelectAll"`
	Link         bool `json:"link"`
	CanSaveLink  bool `json:"canSaveLink"`
	CanPaste     bool `json:"-"`
}

type contextMenuItem struct {
	id        uintptr
	label     string
	enabled   bool
	separator bool
}

var (
	createPopupMenu            = user32.NewProc("CreatePopupMenu")
	appendMenuW                = user32.NewProc("AppendMenuW")
	trackPopupMenu             = user32.NewProc("TrackPopupMenu")
	destroyMenu                = user32.NewProc("DestroyMenu")
	setForegroundWindow        = user32.NewProc("SetForegroundWindow")
	postMessageW               = user32.NewProc("PostMessageW")
	isClipboardFormatAvailable = user32.NewProc("IsClipboardFormatAvailable")
)

func contextMenuItems(options ContextMenuOptions) []contextMenuItem {
	items := make([]contextMenuItem, 0, 7)
	if options.Link {
		items = append(items,
			contextMenuItem{id: menuSaveLink, label: "Save link as…", enabled: options.CanSaveLink},
			contextMenuItem{id: menuCopyLink, label: "Copy link", enabled: true},
			contextMenuItem{separator: true},
		)
	}
	if options.Editable {
		items = append(items, contextMenuItem{id: menuCut, label: "Cut", enabled: options.HasSelection})
	}
	items = append(items, contextMenuItem{id: menuCopy, label: "Copy", enabled: options.HasSelection})
	if options.Editable {
		items = append(items, contextMenuItem{id: menuPaste, label: "Paste", enabled: options.CanPaste})
	}
	items = append(items, contextMenuItem{id: menuSelectAll, label: "Select All", enabled: options.CanSelectAll})
	return items
}

func ShowContextMenu(owner uintptr, options ContextMenuOptions) (string, error) {
	if options.Editable {
		available, _, _ := isClipboardFormatAvailable.Call(cfUnicodeText)
		options.CanPaste = available != 0
	}
	menu, _, callErr := createPopupMenu.Call()
	if menu == 0 {
		return "", fmt.Errorf("create context menu: %w", callErr)
	}
	defer destroyMenu.Call(menu)

	for _, item := range contextMenuItems(options) {
		flags := uintptr(0)
		if item.separator {
			flags = mfSeparator
		}
		if !item.enabled && !item.separator {
			flags |= mfGray
		}
		var label *uint16
		if item.label != "" {
			label, _ = syscall.UTF16PtrFromString(item.label)
		}
		result, _, appendErr := appendMenuW.Call(menu, flags, item.id, uintptr(unsafe.Pointer(label)))
		if result == 0 {
			return "", fmt.Errorf("append context menu item %q: %w", item.label, appendErr)
		}
	}

	var cursor point
	if result, _, _ := getCursorPos.Call(uintptr(unsafe.Pointer(&cursor))); result == 0 {
		return "", errors.New("get context menu position")
	}
	setForegroundWindow.Call(owner)
	command, _, _ := trackPopupMenu.Call(menu, tpmRightButton|tpmReturnCmd, uintptr(cursor.X), uintptr(cursor.Y), 0, owner, 0)
	postMessageW.Call(owner, wmNull, 0, 0)
	switch command {
	case menuCut:
		return "cut", nil
	case menuCopy:
		return "copy", nil
	case menuPaste:
		return "paste", nil
	case menuSelectAll:
		return "selectAll", nil
	case menuSaveLink:
		return "saveLink", nil
	case menuCopyLink:
		return "copyLink", nil
	default:
		return "", nil
	}
}
