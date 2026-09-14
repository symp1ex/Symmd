//go:build windows

// Portions adapted from sympllate.
// Copyright (c) 2026 Eugene S.T. Licensed under the MIT License.

package window

import (
	"errors"
	"sync"
	"syscall"
	"unsafe"

	webview "github.com/jchv/go-webview2"
)

const (
	gwlStyle        = ^uintptr(15)
	gwlpWndProc     = ^uintptr(3)
	wsCaption       = 0x00C00000
	wsSysMenu       = 0x00080000
	wsMinimizeBox   = 0x00020000
	wsMaximizeBox   = 0x00010000
	wsThickFrame    = 0x00040000
	wsPopup         = 0x80000000
	wsVisible       = 0x10000000
	wmGetMinMaxInfo = 0x0024
	wmNCCalcSize    = 0x0083
	wmNCHitTest     = 0x0084
	wmNCDestroy     = 0x0082
	wmClose         = 0x0010
	wmNCLButtonDown = 0x00A1
	htClient        = 1
	htCaption       = 2
	htLeft          = 10
	htRight         = 11
	htTop           = 12
	htTopLeft       = 13
	htTopRight      = 14
	htBottom        = 15
	htBottomLeft    = 16
	htBottomRight   = 17
)

type point struct{ X, Y int32 }
type rect struct{ Left, Top, Right, Bottom int32 }
type minMaxInfo struct{ Reserved, MaxSize, MaxPosition, MinTrackSize, MaxTrackSize point }
type chromeOptions struct {
	minWidth, minHeight, titleHeight, buttonsWidth int32
	onClose                                        func()
}

var (
	user32           = syscall.NewLazyDLL("user32.dll")
	kernel32         = syscall.NewLazyDLL("kernel32.dll")
	getWindowLongPtr = user32.NewProc("GetWindowLongPtrW")
	setWindowLongPtr = user32.NewProc("SetWindowLongPtrW")
	setWindowPos     = user32.NewProc("SetWindowPos")
	callWindowProc   = user32.NewProc("CallWindowProcW")
	getWindowRect    = user32.NewProc("GetWindowRect")
	getCursorPos     = user32.NewProc("GetCursorPos")
	showWindow       = user32.NewProc("ShowWindow")
	isZoomed         = user32.NewProc("IsZoomed")
	releaseCapture   = user32.NewProc("ReleaseCapture")
	sendMessage      = user32.NewProc("SendMessageW")
	copyMemory       = kernel32.NewProc("RtlMoveMemory")
	setDPIAwareness  = user32.NewProc("SetProcessDpiAwarenessContext")
	chromeOnce       sync.Once
	chromeProc       uintptr
	oldProcs         sync.Map
	chromeWindows    sync.Map
)

func applyWindowChrome(w webview.WebView, minWidth, minHeight int, onClose func()) error {
	chromeOnce.Do(func() { chromeProc = syscall.NewCallback(windowChromeProc) })
	hwnd := uintptr(w.Window())
	if hwnd == 0 {
		return errors.New("window HWND is empty")
	}
	options := chromeOptions{int32(minWidth), int32(minHeight), 35, 138, onClose}
	chromeWindows.Store(hwnd, options)
	oldProc, _, _ := getWindowLongPtr.Call(hwnd, gwlpWndProc)
	if oldProc == 0 {
		chromeWindows.Delete(hwnd)
		return errors.New("get window procedure")
	}
	oldProcs.Store(hwnd, oldProc)
	setWindowLongPtr.Call(hwnd, gwlpWndProc, chromeProc)
	style, _, _ := getWindowLongPtr.Call(hwnd, gwlStyle)
	style |= wsCaption | wsSysMenu | wsVisible | wsMinimizeBox | wsMaximizeBox | wsThickFrame
	style &^= wsPopup
	setWindowLongPtr.Call(hwnd, gwlStyle, style)
	setWindowPos.Call(hwnd, 0, 0, 0, 0, 0, 0x0001|0x0002|0x0004|0x0010|0x0020)
	return nil
}

func ApplyChrome(w webview.WebView, minWidth, minHeight int, onClose func()) error {
	return applyWindowChrome(w, minWidth, minHeight, onClose)
}
func Minimize(w webview.WebView)             { minimizeWindow(w) }
func ToggleMaximized(w webview.WebView) bool { return toggleWindowMaximized(w) }
func Drag(w webview.WebView)                 { dragWindow(w) }
func Resize(w webview.WebView, hit uintptr)  { resizeWindow(w, hit) }
func EnableDPIAwareness()                    { setDPIAwareness.Call(^uintptr(3)) }

func minimizeWindow(w webview.WebView) {
	if hwnd := uintptr(w.Window()); hwnd != 0 {
		showWindow.Call(hwnd, 6)
	}
}
func toggleWindowMaximized(w webview.WebView) bool {
	hwnd := uintptr(w.Window())
	if hwnd == 0 {
		return false
	}
	maximized, _, _ := isZoomed.Call(hwnd)
	if maximized != 0 {
		showWindow.Call(hwnd, 9)
		return false
	}
	showWindow.Call(hwnd, 3)
	return true
}
func dragWindow(w webview.WebView) {
	if hwnd := uintptr(w.Window()); hwnd != 0 {
		releaseCapture.Call()
		sendMessage.Call(hwnd, wmNCLButtonDown, htCaption, cursorLParam())
	}
}
func resizeWindow(w webview.WebView, hit uintptr) {
	if hit < htLeft || hit > htBottomRight {
		return
	}
	if hwnd := uintptr(w.Window()); hwnd != 0 {
		releaseCapture.Call()
		sendMessage.Call(hwnd, wmNCLButtonDown, hit, cursorLParam())
	}
}
func cursorLParam() uintptr {
	var p point
	if result, _, _ := getCursorPos.Call(uintptr(unsafe.Pointer(&p))); result == 0 {
		return 0
	}
	return uintptr(uint32(uint16(p.X)) | uint32(uint16(p.Y))<<16)
}
func windowChromeProc(hwnd uintptr, msg uint32, wParam, lParam uintptr) uintptr {
	value, _ := chromeWindows.Load(hwnd)
	options, _ := value.(chromeOptions)
	old, hasOld := oldProcs.Load(hwnd)
	switch msg {
	case wmNCCalcSize:
		return 0
	case wmGetMinMaxInfo:
		updateMinMax(lParam, options)
		return 0
	case wmNCHitTest:
		return hitTest(hwnd, lParam, options)
	case wmClose:
		if options.onClose != nil {
			options.onClose()
			return 0
		}
	case wmNCDestroy:
		oldProcs.Delete(hwnd)
		chromeWindows.Delete(hwnd)
		if hasOld {
			result, _, _ := callWindowProc.Call(old.(uintptr), hwnd, uintptr(msg), wParam, lParam)
			return result
		}
		return htClient
	}
	if hasOld {
		result, _, _ := callWindowProc.Call(old.(uintptr), hwnd, uintptr(msg), wParam, lParam)
		return result
	}
	return htClient
}

func updateMinMax(lParam uintptr, options chromeOptions) {
	if lParam == 0 {
		return
	}
	var info minMaxInfo
	size := unsafe.Sizeof(info)
	copyMemory.Call(uintptr(unsafe.Pointer(&info)), lParam, size)
	info.MinTrackSize.X, info.MinTrackSize.Y = options.minWidth, options.minHeight
	copyMemory.Call(lParam, uintptr(unsafe.Pointer(&info)), size)
}
func hitTest(hwnd, lParam uintptr, options chromeOptions) uintptr {
	var r rect
	if ok, _, _ := getWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&r))); ok == 0 {
		return htClient
	}
	x := int32(int16(uint16(lParam)))
	y := int32(int16(uint16(lParam >> 16)))
	const border = 8
	left, right := x < r.Left+border, x > r.Right-border
	top, bottom := y < r.Top+border, y > r.Bottom-border
	switch {
	case top && left:
		return htTopLeft
	case top && right:
		return htTopRight
	case bottom && left:
		return htBottomLeft
	case bottom && right:
		return htBottomRight
	case left:
		return htLeft
	case right:
		return htRight
	case top:
		return htTop
	case bottom:
		return htBottom
	}
	if y >= r.Top && y < r.Top+options.titleHeight && x < r.Right-options.buttonsWidth {
		return htCaption
	}
	return htClient
}
