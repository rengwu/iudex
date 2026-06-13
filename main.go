package main

import (
	"embed"
	"fmt"
	"os"

	"iudex/internal/cmd"
)

//go:embed all:templates
var templatesFS embed.FS

func main() {
	if err := cmd.Execute(templatesFS); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
