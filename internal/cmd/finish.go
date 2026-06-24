package cmd

import (
	"fmt"

	"github.com/spf13/cobra"

	"iudex/internal/events"
	"iudex/internal/git"
	"iudex/internal/ticket"
	"iudex/internal/workspace"
)

// newFinishCmd hands an active ticket to QA (active -> pending-qa), auto-
// committing a checkpoint if the worktree is dirty, then prints the QA spawn
// command. The ticket is inferred from the current worktree when omitted.
func newFinishCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "finish [ticket-id]",
		Short: "Signal implementation is done; hand off to QA",
		Args:  cobra.MaximumNArgs(1),
		RunE:  runFinish,
	}
}

func runFinish(cmd *cobra.Command, args []string) error {
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
	if s.State != ticket.StateActive {
		return fmt.Errorf("ticket %s is %s, not active", id, s.State)
	}

	out := cmd.OutOrStdout()

	// Don't lose uncommitted work at handoff.
	wt := workspace.Worktree(ctx.Root, id)
	clean, err := git.IsClean(wt)
	if err != nil {
		return err
	}
	if !clean {
		fmt.Fprintln(out, "  uncommitted changes — creating a checkpoint commit…")
		if err := git.WIPCommit(wt, fmt.Sprintf("wip(%s): checkpoint before QA", id)); err != nil {
			return err
		}
	}

	if _, err := events.Append(ctx.Root, events.Event{
		Ticket:  id,
		From:    string(ticket.StateActive),
		To:      string(ticket.StatePendingQA),
		Trigger: string(ticket.TriggerFinish),
	}); err != nil {
		return err
	}

	fmt.Fprintf(out, "✓ %s handed off to QA (pending-qa)\n", id)
	fmt.Fprintln(out, "  spawn the QA agent:")
	fprintSpawnHint(out, ctx.Root, ctx.Config, id, "review.md")
	return nil
}
