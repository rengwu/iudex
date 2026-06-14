package cmd

import (
	"fmt"

	"github.com/spf13/cobra"

	"iudex/internal/ticket"
)

// newNextTicketIDCmd prints the next ticket id N (highest ever registered + 1)
// and nothing else, so it can be used in scripts.
func newNextTicketIDCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "next-ticket-id",
		Short: "Print the next ticket id (highest ever + 1) and nothing else",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, err := loadContext()
			if err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), ticket.MaxID(ctx.Events)+1)
			return nil
		},
	}
}
