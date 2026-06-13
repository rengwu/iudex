package cmd

import "github.com/spf13/cobra"

// newRemoveCmd abandons a ticket from any non-terminal state: archives .task/
// and removes the worktree if one exists, then marks it removed.
func newRemoveCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "remove <ticket-id>",
		Short: "Abandon a ticket from any non-terminal state -> removed",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return stub(cmd, "remove")
		},
	}
}
