//go:build windows

package main

import (
	"os"

	"github.com/symp1ex/symmd/internal/app"
	"github.com/symp1ex/symmd/internal/webassets"
)

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
	if err := app.New(frontend, initial).Run(); err != nil {
		app.ShowError(err)
		os.Exit(1)
	}
}
