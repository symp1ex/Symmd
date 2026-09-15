//go:build windows

package window

import (
	"errors"
	"fmt"
	"os"
	"reflect"
	"unsafe"

	"github.com/jchv/go-webview2/pkg/edge"
	webview "github.com/symp1ex/go-webview2"
)

// ConfigureFrontendOrigin maps a trusted directory to an HTTPS origin and
// installs a navigation-completed observer. go-webview2 exposes both features
// on edge.Chromium but not on its small WebView interface, so this adapter is
// intentionally isolated and validates the pinned wrapper's concrete layout.
func ConfigureFrontendOrigin(w webview.WebView, host, directory string, onNavigationCompleted func()) error {
	if host == "" {
		return errors.New("virtual frontend host is empty")
	}
	info, err := os.Stat(directory)
	if err != nil {
		return fmt.Errorf("stat frontend directory: %w", err)
	}
	if !info.IsDir() {
		return errors.New("frontend path is not a directory")
	}
	chromium, err := chromiumFromWebView(w)
	if err != nil {
		return err
	}
	extended := chromium.GetICoreWebView2_3()
	if extended == nil {
		return errors.New("WebView2 runtime does not support virtual host mapping")
	}
	if err := extended.SetVirtualHostNameToFolderMapping(host, directory, edge.COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY_CORS); err != nil {
		return fmt.Errorf("map frontend virtual host: %w", err)
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
