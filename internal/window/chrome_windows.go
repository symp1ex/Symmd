//go:build windows

// Portions adapted from sympllate.
// Copyright (c) 2026 Eugene S.T. Licensed under the MIT License.

package window

import (
	"errors"
	"sync"
	"syscall"
	"time"
	"unsafe"

	webview "github.com/symp1ex/go-webview2"
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
	wmSetIcon       = 0x0080
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
	iconSmall       = 0
	iconBig         = 1
	imageIcon       = 1
	lrShared        = 0x00008000
	monitorNearest  = 2
	smCXIcon        = 11
	smCYIcon        = 12
	smCXSmallIcon   = 49
	smCYSmallIcon   = 50
)

type point struct{ X, Y int32 }
type rect struct{ Left, Top, Right, Bottom int32 }
type minMaxInfo struct{ Reserved, MaxSize, MaxPosition, MinTrackSize, MaxTrackSize point }
type monitorInfo struct {
	Size    uint32
	Monitor rect
	Work    rect
	Flags   uint32
}
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
	monitorForRect   = user32.NewProc("MonitorFromRect")
	monitorForWindow = user32.NewProc("MonitorFromWindow")
	getMonitorInfo   = user32.NewProc("GetMonitorInfoW")
	getCursorPos     = user32.NewProc("GetCursorPos")
	showWindow       = user32.NewProc("ShowWindow")
	isZoomed         = user32.NewProc("IsZoomed")
	releaseCapture   = user32.NewProc("ReleaseCapture")
	sendMessage      = user32.NewProc("SendMessageW")
	copyMemory       = kernel32.NewProc("RtlMoveMemory")
	setDPIAwareness  = user32.NewProc("SetProcessDpiAwarenessContext")
	getSystemMetrics = user32.NewProc("GetSystemMetrics")
	loadImage        = user32.NewProc("LoadImageW")
	getModuleHandle  = kernel32.NewProc("GetModuleHandleW")
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
func ApplyIcon(w webview.WebView, resourceID uint) error {
	hwnd := uintptr(w.Window())
	if hwnd == 0 {
		return errors.New("window HWND is empty")
	}
	module, _, _ := getModuleHandle.Call(0)
	if module == 0 {
		return errors.New("get application module handle")
	}
	load := func(widthMetric, heightMetric uintptr) uintptr {
		width, _, _ := getSystemMetrics.Call(widthMetric)
		height, _, _ := getSystemMetrics.Call(heightMetric)
		icon, _, _ := loadImage.Call(module, uintptr(resourceID), imageIcon, width, height, lrShared)
		return icon
	}
	bigIcon := load(smCXIcon, smCYIcon)
	smallIcon := load(smCXSmallIcon, smCYSmallIcon)
	if bigIcon == 0 || smallIcon == 0 {
		return errors.New("load application icon resource")
	}
	// LR_SHARED handles are owned by the module cache and must not be destroyed.
	sendMessage.Call(hwnd, wmSetIcon, iconBig, bigIcon)
	sendMessage.Call(hwnd, wmSetIcon, iconSmall, smallIcon)
	return nil
}
func Minimize(w webview.WebView)             { minimizeWindow(w) }
func ToggleMaximized(w webview.WebView) bool { return toggleWindowMaximized(w) }
func Drag(w webview.WebView)                 { dragWindow(w) }
func Resize(w webview.WebView, hit uintptr)  { resizeWindow(w, hit) }
func EnableDPIAwareness()                    { setDPIAwareness.Call(^uintptr(3)) }
func WindowRestoreBounds(hwnd uintptr) (x, y, width, height int32, ok bool) {
	var current rect
	if hwnd == 0 {
		return 0, 0, 0, 0, false
	}
	if result, _, _ := getWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&current))); result == 0 {
		return 0, 0, 0, 0, false
	}
	maximized, _, _ := isZoomed.Call(hwnd)
	var work rect
	workAvailable := false
	if maximized != 0 {
		monitor, ok := windowMonitorInfo(hwnd)
		work, workAvailable = monitor.Work, ok
	}
	restored, ok := restoreRect(current, maximized != 0, work, workAvailable)
	if !ok {
		return 0, 0, 0, 0, false
	}
	return restored.Left, restored.Top, restored.Right - restored.Left, restored.Bottom - restored.Top, true
}
func IsRectVisible(x, y, width, height int32) bool {
	if width <= 0 || height <= 0 {
		return false
	}
	right, bottom := int64(x)+int64(width), int64(y)+int64(height)
	if right > int64(^uint32(0)>>1) || bottom > int64(^uint32(0)>>1) {
		return false
	}
	r := rect{Left: x, Top: y, Right: int32(right), Bottom: int32(bottom)}
	monitor, _, _ := monitorForRect.Call(uintptr(unsafe.Pointer(&r)), 0)
	return monitor != 0
}

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
		time.AfterFunc(100*time.Millisecond, func() {
			w.Dispatch(func() {
				if chromium, err := chromiumFromWebView(w); err == nil {
					chromium.Resize()
				}
			})
		})
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
		if wParam != 0 {
			updateMaximizedClientRect(hwnd, lParam)
		}
		return 0
	case wmGetMinMaxInfo:
		updateMinMax(hwnd, lParam, options)
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

func updateMinMax(hwnd, lParam uintptr, options chromeOptions) {
	if lParam == 0 {
		return
	}
	var info minMaxInfo
	size := unsafe.Sizeof(info)
	copyMemory.Call(uintptr(unsafe.Pointer(&info)), lParam, size)
	if monitor, ok := windowMonitorInfo(hwnd); ok {
		applyMonitorWorkArea(&info, monitor)
	}
	info.MinTrackSize.X, info.MinTrackSize.Y = options.minWidth, options.minHeight
	copyMemory.Call(lParam, uintptr(unsafe.Pointer(&info)), size)
}

func updateMaximizedClientRect(hwnd, lParam uintptr) {
	if lParam == 0 {
		return
	}
	maximized, _, _ := isZoomed.Call(hwnd)
	if maximized == 0 {
		return
	}
	monitor, ok := windowMonitorInfo(hwnd)
	if !ok {
		return
	}
	var proposed rect
	copyMemory.Call(uintptr(unsafe.Pointer(&proposed)), lParam, unsafe.Sizeof(proposed))
	if !coversRect(proposed, monitor.Work) {
		return
	}
	copyMemory.Call(lParam, uintptr(unsafe.Pointer(&monitor.Work)), unsafe.Sizeof(monitor.Work))
}

func windowMonitorInfo(hwnd uintptr) (monitorInfo, bool) {
	monitorHandle, _, _ := monitorForWindow.Call(hwnd, monitorNearest)
	if monitorHandle == 0 {
		return monitorInfo{}, false
	}
	monitor := monitorInfo{Size: uint32(unsafe.Sizeof(monitorInfo{}))}
	ok, _, _ := getMonitorInfo.Call(monitorHandle, uintptr(unsafe.Pointer(&monitor)))
	return monitor, ok != 0
}

func applyMonitorWorkArea(info *minMaxInfo, monitor monitorInfo) {
	info.MaxPosition.X = monitor.Work.Left - monitor.Monitor.Left
	info.MaxPosition.Y = monitor.Work.Top - monitor.Monitor.Top
	info.MaxSize.X = monitor.Work.Right - monitor.Work.Left
	info.MaxSize.Y = monitor.Work.Bottom - monitor.Work.Top
}

func coversRect(outer, inner rect) bool {
	return outer.Left <= inner.Left && outer.Top <= inner.Top && outer.Right >= inner.Right && outer.Bottom >= inner.Bottom
}

func restoreRect(current rect, maximized bool, work rect, workAvailable bool) (rect, bool) {
	if !maximized {
		return current, true
	}
	if !workAvailable {
		return rect{}, false
	}
	return work, true
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
