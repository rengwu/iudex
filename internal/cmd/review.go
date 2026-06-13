package cmd

import "github.com/spf13/cobra"

// newReviewCmd prints everything a human needs to make the human-qa decision:
// brief, log, diff vs main, review.md, current state, and next-action commands.
func newReviewCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "review <ticket-id>",
		Short: "Print brief, log, diff, review, state, and next actions",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return stub(cmd, "review")
		},
	}
}
