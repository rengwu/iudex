package cmd

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"iudex/internal/archive"
	"iudex/internal/events"
	"iudex/internal/git"
	"iudex/internal/ticket"
	"iudex/internal/workspace"
)

// newRemoveCmd abandons a ticket from any non-terminal state: archives .task/
// and removes the worktree if one exists, then marks it removed.
func newRemoveCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "remove <ticket-id>",
		Short: "Abandon a ticket from any non-terminal state -> removed",
		Args:  cobra.ExactArgs(1),
		RunE:  runRemove,
	}
}

func runRemove(cmd *cobra.Command, args []string) error {
	ctx, err := loadContext()
	if err != nil {
		return err
	}
	id := args[0]

	s := ctx.Statuses[id]
	if s == nil {
		return fmt.Errorf("ticket %s is not registered", id)
	}
	if ticket.IsTerminal(s.State) {
		return fmt.Errorf("ticket %s is already %s", id, s.State)
	}

	out := cmd.OutOrStdout()
	wt := workspace.Worktree(ctx.Root, id)
	_, statErr := os.Stat(wt)
	hasWorktree := statErr == nil

	// Capture the work-in-progress diff while the worktree still exists.
	diff := ""
	if hasWorktree {
		if d, derr := git.Diff(wt, ctx.Config.MainBranch); derr == nil {
			diff = d
		}
	}

	// Mark removed first — the abandon decision is the source-of-truth event.
	if _, err := events.Append(ctx.Root, events.Event{
		Ticket:  id,
		From:    string(s.State),
		To:      string(ticket.StateRemoved),
		Trigger: string(ticket.TriggerRemove),
	}); err != nil {
		return err
	}

	// Best-effort archive of whatever context exists.
	evs, _ := events.ReadAll(ctx.Root)
	archDir, archErr := archive.Archive(ctx.Root, id, "removed", "", diff, s.QARejects, evs)
	if archErr != nil {
		fmt.Fprintf(out, "  ⚠ archive failed (ticket is removed): %v\n", archErr)
	}

	// A queued ticket's brief still lives in queue/ (never moved to .task/);
	// preserve it in the archive and clear the queue entry.
	if data, err := os.ReadFile(workspace.QueueFile(ctx.Root, id)); err == nil {
		if archErr == nil {
			_ = os.WriteFile(filepath.Join(archDir, "brief.md"), data, 0o644)
		}
		_ = os.Remove(workspace.QueueFile(ctx.Root, id))
	}

	if hasWorktree {
		if err := git.RemoveWorktree(ctx.Root, wt, ctx.Config.BranchPrefix+id); err != nil {
			fmt.Fprintf(out, "  ⚠ worktree removal failed (ticket is removed): %v\n", err)
		}
	}

	if archErr == nil {
		fmt.Fprintf(out, "✓ %s removed (archived: %s)\n", id, filepath.Join(workspace.Dir, "archive", id))
	} else {
		fmt.Fprintf(out, "✓ %s removed\n", id)
	}
	return nil
}
