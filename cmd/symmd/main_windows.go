//go:build windows

package main

import (
	"os"

	"github.com/symp1ex/symmd/internal/app"
	"github.com/symp1ex/symmd/internal/webassets"
)

const version = "v0.2.2.0"

func main() {
	initial, err := app.LoadInitial(os.Args[1:])
	if err != nil {
		app.ShowError(err)
		os.Exit(1)
	}
	frontend, err := webassets.Load()
	if err != nil {
		app.ShowError(err)
		os.Exit(1)
	}
	if err := app.New(frontend, initial, version).Run(); err != nil {
		app.ShowError(err)
		os.Exit(1)
	}
}
