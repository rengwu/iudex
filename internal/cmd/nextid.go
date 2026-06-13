package cmd

import "github.com/spf13/cobra"

// newNextTicketIDCmd prints the next ticket id N (highest ever registered + 1)
// and nothing else, so it can be used in scripts.
func newNextTicketIDCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "next-ticket-id",
		Short: "Print the next ticket id (highest ever + 1) and nothing else",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			return stub(cmd, "next-ticket-id")
		},
	}
}
