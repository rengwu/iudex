package cmd

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/spf13/cobra"

	"iudex/internal/ticket"
	"iudex/internal/workspace"
)

// newStatusCmd prints tickets grouped by state, with queued tickets annotated
// ready/blocked and failed tickets showing their reject count. done/removed are
// hidden unless --all is passed.
func newStatusCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "status",
		Short: "Print tickets grouped by state",
		Args:  cobra.NoArgs,
		RunE:  runStatus,
	}
	cmd.Flags().Bool("all", false, "include done and removed tickets")
	return cmd
}

func runStatus(cmd *cobra.Command, _ []string) error {
	all, err := cmd.Flags().GetBool("all")
	if err != nil {
		return err
	}
	ctx, err := loadContext()
	if err != nil {
		return err
	}

	groups := []struct {
		heading string
		state   ticket.State
	}{
		{"QUEUED", ticket.StateQueued},
		{"ACTIVE", ticket.StateActive},
		{"PENDING-QA", ticket.StatePendingQA},
		{"PENDING-HUMAN-QA", ticket.StatePendingHumanQA},
		{"FAILED", ticket.StateFailed},
	}
	if all {
		groups = append(groups,
			struct {
				heading string
				state   ticket.State
			}{"DONE", ticket.StateDone},
			struct {
				heading string
				state   ticket.State
			}{"REMOVED", ticket.StateRemoved},
		)
	}

	out := cmd.OutOrStdout()
	for _, g := range groups {
		fmt.Fprintln(out, g.heading)
		ids := idsInState(ctx.Statuses, g.state)
		if len(ids) == 0 {
			fmt.Fprintln(out, "  (none)")
			continue
		}
		for _, id := range ids {
			line := fmt.Sprintf("  %-6s %s", id, annotate(g.state, ctx.Statuses[id], ctx.Statuses))
			fmt.Fprintln(out, strings.TrimRight(line, " "))
		}
	}
	return nil
}

// idsInState returns the ticket ids in the given state, ordered by number.
func idsInState(all map[string]*ticket.Status, state ticket.State) []string {
	var ids []string
	for id, s := range all {
		if s.State == state {
			ids = append(ids, id)
		}
	}
	sort.Slice(ids, func(i, j int) bool {
		ni, _ := ticket.ParseID(ids[i])
		nj, _ := ticket.ParseID(ids[j])
		return ni < nj
	})
	return ids
}

// annotate returns the trailing detail shown after a ticket id for its state.
func annotate(state ticket.State, s *ticket.Status, all map[string]*ticket.Status) string {
	switch state {
	case ticket.StateQueued:
		ready, blocking := ticket.DepsReady(s, all)
		if ready {
			return "ready"
		}
		parts := make([]string, 0, len(blocking))
		for _, dep := range blocking {
			ds := "unregistered"
			if d := all[dep]; d != nil {
				ds = string(d.State)
			}
			parts = append(parts, fmt.Sprintf("%s (%s)", dep, ds))
		}
		return "blocked by: " + strings.Join(parts, ", ")
	case ticket.StateActive:
		return filepath.Join(workspace.Dir, "worktrees", s.Ticket)
	case ticket.StateFailed:
		unit := "rejections"
		if s.QARejects == 1 {
			unit = "rejection"
		}
		return fmt.Sprintf("%d QA %s", s.QARejects, unit)
	default:
		return ""
	}
}
