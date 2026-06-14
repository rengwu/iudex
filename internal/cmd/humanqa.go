package cmd

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"text/template"
	"time"

	"github.com/spf13/cobra"

	"iudex/internal/archive"
	"iudex/internal/events"
	"iudex/internal/git"
	"iudex/internal/ticket"
	"iudex/internal/workspace"
)

// newHumanQACmd is the `iudex human-qa` command group for the human review
// phase. approve merges/archives/removes; reject sends the ticket back to
// active with feedback appended to .task/review.md.
func newHumanQACmd() *cobra.Command {
	hq := &cobra.Command{
		Use:   "human-qa",
		Short: "Human QA actions (approve, reject)",
	}
	hq.AddCommand(&cobra.Command{
		Use:   "approve <ticket-id>",
		Short: "Approve: merge to main, archive, remove worktree -> done",
		Args:  cobra.ExactArgs(1),
		RunE:  runHumanQAApprove,
	})
	reject := &cobra.Command{
		Use:   "reject <ticket-id>",
		Short: "Reject: pending-human-qa -> active, append feedback to review.md",
		Args:  cobra.ExactArgs(1),
		RunE:  runHumanQAReject,
	}
	reject.Flags().String("reason", "", "feedback appended to .task/review.md for the next impl session")
	hq.AddCommand(reject)
	return hq
}

// pendingHumanQATicket resolves the ticket and verifies it awaits human QA.
func pendingHumanQATicket(id string) (*wsContext, error) {
	ctx, err := loadContext()
	if err != nil {
		return nil, err
	}
	s := ctx.Statuses[id]
	if s == nil {
		return nil, fmt.Errorf("ticket %s is not registered", id)
	}
	if s.State != ticket.StatePendingHumanQA {
		return nil, fmt.Errorf("ticket %s is %s, not pending-human-qa", id, s.State)
	}
	return ctx, nil
}

func runHumanQAApprove(cmd *cobra.Command, args []string) error {
	id := args[0]
	ctx, err := pendingHumanQATicket(id)
	if err != nil {
		return err
	}
	out := cmd.OutOrStdout()

	// The merge happens in the repo root; refuse (doing nothing) unless it is on
	// the canonical branch and clean, so we never clobber the user's work.
	branch, err := git.CurrentBranch(ctx.Root)
	if err != nil {
		return err
	}
	if branch != ctx.Config.MainBranch {
		return fmt.Errorf("refusing to merge: repo root is on %q, not %q — switch branches first", branch, ctx.Config.MainBranch)
	}
	if clean, err := git.IsClean(ctx.Root); err != nil {
		return err
	} else if !clean {
		return fmt.Errorf("refusing to merge: repo root has uncommitted changes — commit or stash them first")
	}

	wt := workspace.Worktree(ctx.Root, id)
	workBranch := ctx.Config.BranchPrefix + id

	// Capture the diff before merging; afterwards main...HEAD collapses.
	diff, err := git.Diff(wt, ctx.Config.MainBranch)
	if err != nil {
		return fmt.Errorf("capture diff: %w", err)
	}

	commit, err := git.Merge(ctx.Root, workBranch, ctx.Config.MergeStrategy, mergeMessage(ctx.Config.MergeMessageTemplate, id))
	if err != nil {
		return fmt.Errorf("%w\n  ticket stays pending-human-qa, worktree preserved — resolve the conflict and re-approve", err)
	}
	fmt.Fprintf(out, "✓ merged %s into %s (%s)\n", workBranch, ctx.Config.MainBranch, shortHash(commit))

	// Mark done immediately after the irreversible step. Archiving and worktree
	// removal are best-effort cleanup; their failure leaves the ticket done.
	if _, err := events.Append(ctx.Root, events.Event{
		Ticket:  id,
		From:    string(ticket.StatePendingHumanQA),
		To:      string(ticket.StateDone),
		Trigger: string(ticket.TriggerHumanQAApprove),
		Reason:  "merge " + commit,
	}); err != nil {
		return err
	}

	evs, _ := events.ReadAll(ctx.Root)
	if _, err := archive.Archive(ctx.Root, id, "done", commit, diff, ctx.Statuses[id].QARejects, evs); err != nil {
		fmt.Fprintf(out, "  ⚠ archive failed (ticket is done): %v\n", err)
	} else {
		fmt.Fprintf(out, "  archived: %s\n", filepath.Join(workspace.Dir, "archive", id))
	}
	if err := git.RemoveWorktree(ctx.Root, wt, workBranch); err != nil {
		fmt.Fprintf(out, "  ⚠ worktree removal failed (ticket is done): %v\n", err)
	}

	fmt.Fprintf(out, "✓ %s done\n", id)
	return nil
}

func runHumanQAReject(cmd *cobra.Command, args []string) error {
	id := args[0]
	ctx, err := pendingHumanQATicket(id)
	if err != nil {
		return err
	}
	reason, _ := cmd.Flags().GetString("reason")

	if reason != "" {
		if err := appendHumanFeedback(ctx.Root, id, reason); err != nil {
			return fmt.Errorf("record feedback: %w", err)
		}
	}

	if _, err := events.Append(ctx.Root, events.Event{
		Ticket:  id,
		From:    string(ticket.StatePendingHumanQA),
		To:      string(ticket.StateActive),
		Trigger: string(ticket.TriggerHumanQAReject),
		Reason:  reason,
	}); err != nil {
		return err
	}

	out := cmd.OutOrStdout()
	fmt.Fprintf(out, "↩ %s sent back for revision (active)\n", id)
	if reason == "" {
		fmt.Fprintln(out, "  note: no --reason given; add guidance to .task/review.md so the next session has feedback")
	}
	fmt.Fprintln(out, "  spawn the implementation agent (it will read .task/review.md):")
	fmt.Fprintf(out, "    %s\n", spawnCommand(ctx.Root, ctx.Config, id, "impl.md"))
	return nil
}

// appendHumanFeedback appends a timestamped Human QA section to .task/review.md,
// creating the file if necessary.
func appendHumanFeedback(root, id, reason string) error {
	p := filepath.Join(workspace.TaskDir(root, id), "review.md")
	f, err := os.OpenFile(p, os.O_APPEND|os.O_WRONLY|os.O_CREATE, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = fmt.Fprintf(f, "\n## Human QA feedback (%s)\n\n%s\n", time.Now().UTC().Format(time.RFC3339), reason)
	return err
}

// mergeMessage renders the configured merge message template with the ticket id.
func mergeMessage(tmpl, id string) string {
	t, err := template.New("merge").Parse(tmpl)
	if err != nil {
		return fmt.Sprintf("merge %s", id)
	}
	var b strings.Builder
	if err := t.Execute(&b, map[string]string{"Ticket": id}); err != nil {
		return fmt.Sprintf("merge %s", id)
	}
	return b.String()
}

func shortHash(h string) string {
	if len(h) > 12 {
		return h[:12]
	}
	return h
}
