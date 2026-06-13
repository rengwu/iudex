package cmd

import "github.com/spf13/cobra"

// newQueueCmd registers an authored ticket markdown file into the queue,
// recording its blocking dependencies in the event log. It rejects reused ids
// and deps that are not already registered (or are removed/failed).
func newQueueCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "queue <ticket-id>",
		Short: "Register a queued ticket and its dependencies",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return stub(cmd, "queue")
		},
	}
	cmd.Flags().StringSlice("deps", nil, "comma-separated blocking ticket ids (must already be registered)")
	return cmd
}
