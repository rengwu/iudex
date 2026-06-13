package cmd

import "github.com/spf13/cobra"

// newStatusCmd prints tickets grouped by state, with queued tickets annotated
// ready/blocked and failed tickets showing their reject count. done/removed are
// hidden unless --all is passed.
func newStatusCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "status",
		Short: "Print tickets grouped by state",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			return stub(cmd, "status")
		},
	}
	cmd.Flags().Bool("all", false, "include done and removed tickets")
	return cmd
}
