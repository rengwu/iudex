package cmd

import (
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"iudex/internal/git"
	"iudex/internal/ticket"
	"iudex/internal/workspace"
)

// newReviewCmd prints everything a human needs to make the human-qa decision:
// brief, log, diff vs main, review.md, current state, and next-action commands.
func newReviewCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "review <ticket-id>",
		Short: "Print brief, log, diff, review, state, and next actions",
		Args:  cobra.ExactArgs(1),
		RunE:  runReview,
	}
}

func runReview(cmd *cobra.Command, args []string) error {
	ctx, err := loadContext()
	if err != nil {
		return err
	}
	id := args[0]

	s := ctx.Statuses[id]
	if s == nil {
		return fmt.Errorf("ticket %s is not registered", id)
	}

	out := cmd.OutOrStdout()
	taskDir := workspace.TaskDir(ctx.Root, id)

	section(out, "BRIEF", readOr(filepath.Join(taskDir, "brief.md"), "(none)"))
	section(out, "IMPLEMENTATION LOG", readOr(filepath.Join(taskDir, "log.md"), "(none)"))

	wt := workspace.Worktree(ctx.Root, id)
	if _, err := os.Stat(wt); err == nil {
		diff, derr := git.Diff(wt, ctx.Config.MainBranch)
		if derr != nil {
			section(out, "DIFF (vs "+ctx.Config.MainBranch+")", "(unavailable: "+derr.Error()+")")
		} else if diff == "" {
			section(out, "DIFF (vs "+ctx.Config.MainBranch+")", "(no changes)")
		} else {
			section(out, "DIFF (vs "+ctx.Config.MainBranch+")", diff)
		}
	} else {
		section(out, "DIFF (vs "+ctx.Config.MainBranch+")", "(no worktree; see the archive for completed tickets)")
	}

	section(out, "QA REVIEW", readOr(filepath.Join(taskDir, "review.md"), "(not written)"))

	fmt.Fprintf(out, "\nstate: %s\n", s.State)
	printNextActions(out, id, s.State)
	return nil
}

func section(w io.Writer, title, body string) {
	fmt.Fprintf(w, "\n=== %s ===\n%s\n", title, body)
}

func readOr(path, fallback string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return fallback
	}
	return string(data)
}

func printNextActions(w io.Writer, id string, state ticket.State) {
	switch state {
	case ticket.StatePendingHumanQA:
		fmt.Fprintf(w, "  approve: iudex human-qa approve %s\n", id)
		fmt.Fprintf(w, "  reject:  iudex human-qa reject %s --reason \"...\"\n", id)
		fmt.Fprintf(w, "  abandon: iudex remove %s\n", id)
	case ticket.StateFailed:
		fmt.Fprintf(w, "  retry:   iudex retry %s\n", id)
		fmt.Fprintf(w, "  abandon: iudex remove %s\n", id)
	}
}
