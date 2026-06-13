package cmd

import "github.com/spf13/cobra"

// newInitCmd scaffolds the current directory into an iudex workspace: ensures a
// git repo + initial commit if needed, records the current branch as
// main_branch, creates .iudex/ from embedded templates, and gitignores .iudex/.
func newInitCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "init",
		Short: "Scaffold the current directory into an iudex workspace",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			return stub(cmd, "init")
		},
	}
}
