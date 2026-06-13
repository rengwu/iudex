package cmd

import "github.com/spf13/cobra"

// newHumanQACmd is the `iudex human-qa` command group for the human review
// phase. approve merges/archives/removes; reject sends the ticket back to
// active with feedback appended to .task/review.md.
func newHumanQACmd() *cobra.Command {
	hq := &cobra.Command{
		Use:   "human-qa",
		Short: "Human QA actions (approve, reject)",
	}
	hq.AddCommand(
		&cobra.Command{
			Use:   "approve <ticket-id>",
			Short: "Approve: merge to main, archive, remove worktree -> done",
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				return stub(cmd, "human-qa approve")
			},
		},
	)

	reject := &cobra.Command{
		Use:   "reject <ticket-id>",
		Short: "Reject: pending-human-qa -> active, append feedback to review.md",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return stub(cmd, "human-qa reject")
		},
	}
	reject.Flags().String("reason", "", "feedback appended to .task/review.md for the next impl session")
	hq.AddCommand(reject)

	return hq
}
