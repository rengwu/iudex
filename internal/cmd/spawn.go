package cmd

import "github.com/spf13/cobra"

// newSpawnCmd prints the agent spawn command for a ticket's current state (impl
// when active, QA when pending-qa). The ticket is inferred from the current
// worktree when omitted. iudex never launches the agent itself.
func newSpawnCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "spawn [ticket-id]",
		Short: "Print the agent spawn command for a ticket's current state",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return stub(cmd, "spawn")
		},
	}
}
