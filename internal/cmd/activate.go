package cmd

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"iudex/internal/events"
	"iudex/internal/git"
	"iudex/internal/ticket"
	"iudex/internal/workspace"
)

// newActivateCmd moves a queued ticket to active: checks all deps are done and
// the max_active cap, creates the worktree + .task/ (moving the brief in), and
// prints the impl spawn command.
func newActivateCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "activate <ticket-id>",
		Short: "Activate a queued ticket (create its worktree)",
		Args:  cobra.ExactArgs(1),
		RunE:  runActivate,
	}
}

func runActivate(cmd *cobra.Command, args []string) error {
	id := args[0]
	if _, ok := ticket.ParseID(id); !ok {
		return fmt.Errorf("invalid ticket id %q (expected form t<N>, e.g. t5)", id)
	}

	ctx, err := loadContext()
	if err != nil {
		return err
	}

	// --- preconditions (validate everything before mutating anything) ---

	s := ctx.Statuses[id]
	if s == nil {
		return fmt.Errorf("ticket %s is not registered — queue it first", id)
	}
	if s.State != ticket.StateQueued {
		return fmt.Errorf("ticket %s is %s, not queued", id, s.State)
	}

	if ready, blocking := ticket.DepsReady(s, ctx.Statuses); !ready {
		return fmt.Errorf("cannot activate %s: %s", id, describeBlocking(blocking, ctx.Statuses))
	}

	if cap := ctx.Config.MaxActive; cap > 0 {
		if active := countInState(ctx.Statuses, ticket.StateActive); active >= cap {
			return fmt.Errorf("max_active reached (%d active) — finish or retry an active ticket first", cap)
		}
	}

	briefSrc := workspace.QueueFile(ctx.Root, id)
	if _, err := os.Stat(briefSrc); err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("brief %s has gone missing; cannot activate", filepath.Join(workspace.Dir, "queue", id+".md"))
		}
		return err
	}

	// --- mutations ---

	dest := workspace.Worktree(ctx.Root, id)
	branch := ctx.Config.BranchPrefix + id
	if err := git.CreateWorktree(ctx.Root, dest, branch, ctx.Config.MainBranch); err != nil {
		return err
	}

	// Ignore .task/ across the repo so the brief/log/review never get committed.
	if err := git.EnsureExclude(ctx.Root, ".task/"); err != nil {
		return fmt.Errorf("exclude .task/: %w", err)
	}

	taskDir := workspace.TaskDir(ctx.Root, id)
	if err := os.MkdirAll(taskDir, 0o755); err != nil {
		return err
	}
	if err := os.Rename(briefSrc, filepath.Join(taskDir, "brief.md")); err != nil {
		return fmt.Errorf("move brief into .task/: %w", err)
	}
	logBody := fmt.Sprintf("# Implementation Log: %s\n\n_Append notes, decisions, and handoff context as you work._\n", id)
	if err := os.WriteFile(filepath.Join(taskDir, "log.md"), []byte(logBody), 0o644); err != nil {
		return err
	}

	if _, err := events.Append(ctx.Root, events.Event{
		Ticket:  id,
		From:    string(ticket.StateQueued),
		To:      string(ticket.StateActive),
		Trigger: string(ticket.TriggerActivate),
	}); err != nil {
		return err
	}

	out := cmd.OutOrStdout()
	fmt.Fprintf(out, "✓ activated %s\n", id)
	fmt.Fprintf(out, "  worktree: %s\n", filepath.Join(workspace.Dir, "worktrees", id))
	fmt.Fprintln(out, "  spawn the implementation agent:")
	fprintSpawnHint(out, ctx.Root, ctx.Config, id, "impl.md")
	return nil
}

// countInState returns how many tickets are currently in the given state.
func countInState(all map[string]*ticket.Status, state ticket.State) int {
	n := 0
	for _, s := range all {
		if s.State == state {
			n++
		}
	}
	return n
}

// describeBlocking renders the unmet dependencies of a ticket with their states.
func describeBlocking(blocking []string, all map[string]*ticket.Status) string {
	parts := make([]string, 0, len(blocking))
	for _, dep := range blocking {
		ds := "unregistered"
		if d := all[dep]; d != nil {
			ds = string(d.State)
		}
		parts = append(parts, fmt.Sprintf("%s (%s)", dep, ds))
	}
	return "blocked by: " + strings.Join(parts, ", ")
}
