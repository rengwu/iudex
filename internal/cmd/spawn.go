package cmd

import (
	"fmt"

	"github.com/spf13/cobra"

	"iudex/internal/ticket"
)

// newSpawnCmd prints the agent spawn command for a ticket's current state (impl
// when active, QA when pending-qa). The ticket is inferred from the current
// worktree when omitted. iudex never launches the agent itself.
func newSpawnCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "spawn [ticket-id]",
		Short: "Print the agent spawn command for a ticket's current state",
		Args:  cobra.MaximumNArgs(1),
		RunE:  runSpawn,
	}
}

func runSpawn(cmd *cobra.Command, args []string) error {
	ctx, err := loadContext()
	if err != nil {
		return err
	}
	id, err := resolveTicket(ctx.Root, args)
	if err != nil {
		return err
	}

	s := ctx.Statuses[id]
	if s == nil {
		return fmt.Errorf("ticket %s is not registered", id)
	}

	var promptFile string
	switch s.State {
	case ticket.StateActive:
		promptFile = "impl.md"
	case ticket.StatePendingQA:
		promptFile = "review.md"
	default:
		return fmt.Errorf("ticket %s is %s — spawn applies only to active (impl) or pending-qa (QA)", id, s.State)
	}

	out, err := spawnCommand(ctx.Root, ctx.Config, id, promptFile)
	if err != nil {
		return err
	}
	fmt.Fprintln(cmd.OutOrStdout(), out)
	return nil
}
