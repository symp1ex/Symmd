//go:build windows

package window

import (
	"errors"
	"fmt"
	"reflect"
	"sync"
	"unsafe"

	webview "github.com/symp1ex/go-webview2"
	"github.com/symp1ex/go-webview2/pkg/edge"
	"golang.org/x/sys/windows"
)

const (
	virtualKeyControl = 0x11
	virtualKeyF       = 0x46
	virtualKeyF3      = 0x72
)

var (
	getKeyState                        = user32.NewProc("GetKeyState")
	browserFindHandlersMu              sync.Mutex
	browserFindHandlers                []*browserFindAcceleratorHandler
	acceleratorKeyPressedEventArgs2IID = windows.GUID{Data1: 0x03b2c8c8, Data2: 0x7799, Data3: 0x4e34, Data4: [8]byte{0xbd, 0x66, 0xed, 0x26, 0xaa, 0x85, 0xf2, 0xbf}}
)

// ConfigureNavigationCompleted installs the existing navigation-completed
// observer. The standalone wrapper does not expose this callback on its small
// WebView interface, so this adapter remains isolated here.
func ConfigureNavigationCompleted(w webview.WebView, onNavigationCompleted func()) error {
	chromium, err := chromiumFromWebView(w)
	if err != nil {
		return err
	}
	chromium.NavigationCompletedCallback = func(_ *edge.ICoreWebView2, _ *edge.ICoreWebView2NavigationCompletedEventArgs) {
		if onNavigationCompleted != nil {
			onNavigationCompleted()
		}
	}
	return nil
}

func DisableBrowserZoom(w webview.WebView) error {
	chromium, err := chromiumFromWebView(w)
	if err != nil {
		return err
	}
	settings, err := chromium.GetSettings()
	if err != nil {
		return fmt.Errorf("get WebView2 settings: %w", err)
	}
	if err := settings.PutIsZoomControlEnabled(false); err != nil {
		return fmt.Errorf("disable WebView2 zoom control: %w", err)
	}
	return nil
}

func DisableBrowserAcceleratorKeys(w webview.WebView) error {
	chromium, err := chromiumFromWebView(w)
	if err != nil {
		return err
	}
	settings, err := chromium.GetSettings()
	if err != nil {
		return fmt.Errorf("get WebView2 settings: %w", err)
	}
	if err := disableBrowserAcceleratorKeys(settings); err != nil {
		return fmt.Errorf("disable WebView2 browser accelerator keys: %w", err)
	}
	return nil
}

type browserAcceleratorSettings interface {
	PutAreBrowserAcceleratorKeysEnabled(bool) error
}

func disableBrowserAcceleratorKeys(settings browserAcceleratorSettings) error {
	return settings.PutAreBrowserAcceleratorKeysEnabled(false)
}

// EnableBrowserFindAccelerators selectively restores WebView2's native Find on
// Page while the global browser-accelerator setting remains disabled.
func EnableBrowserFindAccelerators(w webview.WebView, enabled func() bool) error {
	chromium, err := chromiumFromWebView(w)
	if err != nil {
		return err
	}
	handler := newBrowserFindAcceleratorHandler(enabled)
	if err := chromium.GetController().AddAcceleratorKeyPressed((*edge.ICoreWebView2AcceleratorKeyPressedEventHandler)(unsafe.Pointer(handler)), nil); err != nil {
		return fmt.Errorf("register WebView2 find accelerator handler: %w", err)
	}
	// WebView2 owns a COM reference, but Go's collector cannot see it through
	// the native event registration. Keep the Go callback alive for the window.
	browserFindHandlersMu.Lock()
	browserFindHandlers = append(browserFindHandlers, handler)
	browserFindHandlersMu.Unlock()
	return nil
}

func isBrowserFindAccelerator(virtualKey uint, control, enabled bool) bool {
	return enabled && (virtualKey == virtualKeyF3 || control && virtualKey == virtualKeyF)
}

type browserFindAcceleratorHandlerVtbl struct {
	queryInterface edge.ComProc
	addRef         edge.ComProc
	release        edge.ComProc
	invoke         edge.ComProc
}

type browserFindAcceleratorHandler struct {
	vtbl    *browserFindAcceleratorHandlerVtbl
	enabled func() bool
}

var browserFindAcceleratorHandlerVTable = browserFindAcceleratorHandlerVtbl{
	queryInterface: edge.NewComProc(browserFindAcceleratorHandlerQueryInterface),
	addRef:         edge.NewComProc(browserFindAcceleratorHandlerAddRef),
	release:        edge.NewComProc(browserFindAcceleratorHandlerRelease),
	invoke:         edge.NewComProc(browserFindAcceleratorHandlerInvoke),
}

func newBrowserFindAcceleratorHandler(enabled func() bool) *browserFindAcceleratorHandler {
	return &browserFindAcceleratorHandler{vtbl: &browserFindAcceleratorHandlerVTable, enabled: enabled}
}

func browserFindAcceleratorHandlerQueryInterface(_ *browserFindAcceleratorHandler, _, _ uintptr) uintptr {
	return 0
}

func browserFindAcceleratorHandlerAddRef(_ *browserFindAcceleratorHandler) uintptr  { return 1 }
func browserFindAcceleratorHandlerRelease(_ *browserFindAcceleratorHandler) uintptr { return 1 }

func browserFindAcceleratorHandlerInvoke(handler *browserFindAcceleratorHandler, _ *edge.ICoreWebView2Controller, args *edge.ICoreWebView2AcceleratorKeyPressedEventArgs) uintptr {
	eventKind, err := args.GetKeyEventKind()
	if err != nil || eventKind != edge.COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN && eventKind != edge.COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN {
		return 0
	}
	virtualKey, err := args.GetVirtualKey()
	if err != nil || virtualKey != virtualKeyF && virtualKey != virtualKeyF3 {
		return 0
	}
	control := false
	if virtualKey == virtualKeyF {
		state, _, _ := getKeyState.Call(virtualKeyControl)
		control = int16(state) < 0
		if !control {
			return 0
		}
	}
	_ = putBrowserAcceleratorKeyEnabled(args, isBrowserFindAccelerator(virtualKey, control, handler.enabled()))
	return 0
}

type unknownVtbl struct {
	queryInterface edge.ComProc
	addRef         edge.ComProc
	release        edge.ComProc
}

type unknown struct{ vtbl *unknownVtbl }

type acceleratorKeyPressedEventArgs2Vtbl struct {
	unknownVtbl
	getKeyEventKind                edge.ComProc
	getVirtualKey                  edge.ComProc
	getKeyEventLParam              edge.ComProc
	getPhysicalKeyStatus           edge.ComProc
	getHandled                     edge.ComProc
	putHandled                     edge.ComProc
	getIsBrowserAcceleratorEnabled edge.ComProc
	putIsBrowserAcceleratorEnabled edge.ComProc
}

type acceleratorKeyPressedEventArgs2 struct {
	vtbl *acceleratorKeyPressedEventArgs2Vtbl
}

func putBrowserAcceleratorKeyEnabled(args *edge.ICoreWebView2AcceleratorKeyPressedEventArgs, enabled bool) error {
	base := (*unknown)(unsafe.Pointer(args))
	var extended *acceleratorKeyPressedEventArgs2
	result, _, _ := base.vtbl.queryInterface.Call(
		uintptr(unsafe.Pointer(args)),
		uintptr(unsafe.Pointer(&acceleratorKeyPressedEventArgs2IID)),
		uintptr(unsafe.Pointer(&extended)),
	)
	if int32(result) < 0 || extended == nil {
		return fmt.Errorf("query WebView2 accelerator args v2: HRESULT 0x%08x", uint32(result))
	}
	defer extended.vtbl.release.Call(uintptr(unsafe.Pointer(extended)))
	value := uintptr(0)
	if enabled {
		value = 1
	}
	result, _, _ = extended.vtbl.putIsBrowserAcceleratorEnabled.Call(uintptr(unsafe.Pointer(extended)), value)
	if int32(result) < 0 {
		return fmt.Errorf("set WebView2 browser accelerator: HRESULT 0x%08x", uint32(result))
	}
	return nil
}

func chromiumFromWebView(w webview.WebView) (*edge.Chromium, error) {
	value := reflect.ValueOf(w)
	if !value.IsValid() || value.Kind() != reflect.Pointer || value.IsNil() {
		return nil, errors.New("invalid go-webview2 instance")
	}
	browser := value.Elem().FieldByName("browser")
	if !browser.IsValid() || !browser.CanAddr() {
		return nil, errors.New("incompatible go-webview2: browser field is unavailable")
	}
	// The dependency is pinned in go.mod. NewAt is required only because the
	// wrapper keeps its already-exported *edge.Chromium behind a private field.
	browser = reflect.NewAt(browser.Type(), unsafe.Pointer(browser.UnsafeAddr())).Elem()
	chromium, ok := browser.Interface().(*edge.Chromium)
	if !ok || chromium == nil {
		return nil, errors.New("incompatible go-webview2: Chromium backend is unavailable")
	}
	return chromium, nil
}
