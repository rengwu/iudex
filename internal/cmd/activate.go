package cmd

import "github.com/spf13/cobra"

// newActivateCmd moves a queued ticket to active: checks all deps are done and
// the max_active cap, creates the worktree + .task/ (moving the brief in), and
// prints the impl spawn command.
func newActivateCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "activate <ticket-id>",
		Short: "Activate a queued ticket (create its worktree)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return stub(cmd, "activate")
		},
	}
}
