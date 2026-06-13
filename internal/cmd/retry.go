package cmd

import "github.com/spf13/cobra"

// newRetryCmd moves a failed ticket back to active and resets its QA-reject
// counter for a fresh attempt in the preserved worktree.
func newRetryCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "retry <ticket-id>",
		Short: "Retry a failed ticket: failed -> active, reset reject counter",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return stub(cmd, "retry")
		},
	}
}
