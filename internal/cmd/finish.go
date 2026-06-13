package cmd

import "github.com/spf13/cobra"

// newFinishCmd hands an active ticket to QA (active -> pending-qa), auto-
// committing a checkpoint if the worktree is dirty, then prints the QA spawn
// command. The ticket is inferred from the current worktree when omitted.
func newFinishCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "finish [ticket-id]",
		Short: "Signal implementation is done; hand off to QA",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return stub(cmd, "finish")
		},
	}
}
