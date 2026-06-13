package cmd

import "github.com/spf13/cobra"

// newQACmd is the `iudex qa` command group for the agent QA phase. The ticket is
// inferred from the current worktree when omitted.
func newQACmd() *cobra.Command {
	qa := &cobra.Command{
		Use:   "qa",
		Short: "Agent QA actions (approve, reject)",
	}
	qa.AddCommand(
		&cobra.Command{
			Use:   "approve [ticket-id]",
			Short: "Approve QA: pending-qa -> pending-human-qa",
			Args:  cobra.MaximumNArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				return stub(cmd, "qa approve")
			},
		},
		&cobra.Command{
			Use:   "reject [ticket-id]",
			Short: "Reject QA: pending-qa -> active (or -> failed at the limit)",
			Args:  cobra.MaximumNArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				return stub(cmd, "qa reject")
			},
		},
	)
	return qa
}
