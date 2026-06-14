// Package cmd defines the iudex CLI command tree (cobra).
package cmd

import (
	"embed"

	"github.com/spf13/cobra"
)

// templatesFS holds the embedded workspace templates, injected by Execute and
// consumed by `iudex init`.
var templatesFS embed.FS

// Execute builds the root command and runs it. The embedded templates FS is
// passed from main.
func Execute(fs embed.FS) error {
	templatesFS = fs
	return newRootCmd().Execute()
}

func newRootCmd() *cobra.Command {
	root := &cobra.Command{
		Use:   "iudex",
		Short: "Command-driven orchestration of AI coding agents across git worktrees",
		Long: "iudex drives tickets through a queue -> implement -> QA -> human-review -> merge\n" +
			"pipeline using git worktrees and an append-only event log. Every transition is an\n" +
			"explicit command; there is no background process.",
		SilenceUsage: true,
	}
	root.AddCommand(
		newInitCmd(),
		newNextTicketIDCmd(),
		newQueueCmd(),
		newActivateCmd(),
		newFinishCmd(),
		newQACmd(),
		newHumanQACmd(),
		newRetryCmd(),
		newRemoveCmd(),
		newReviewCmd(),
		newSpawnCmd(),
		newStatusCmd(),
	)
	return root
}
