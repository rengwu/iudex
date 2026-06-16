package cmd

import (
	"encoding/json"
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
// hidden unless --all is passed. With --json it instead emits the full machine-
// readable workspace state (every ticket, all derived fields), which is the read
// path the GUI client binds to.
func newStatusCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "status",
		Short: "Print tickets grouped by state",
		Args:  cobra.NoArgs,
		RunE:  runStatus,
	}
	cmd.Flags().Bool("all", false, "include done and removed tickets")
	cmd.Flags().Bool("json", false, "emit machine-readable JSON (all tickets; ignores --all)")
	return cmd
}

func runStatus(cmd *cobra.Command, _ []string) error {
	all, err := cmd.Flags().GetBool("all")
	if err != nil {
		return err
	}
	asJSON, err := cmd.Flags().GetBool("json")
	if err != nil {
		return err
	}
	ctx, err := loadContext()
	if err != nil {
		return err
	}
	if asJSON {
		return runStatusJSON(cmd, ctx)
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

// jsonWorkspace is the machine-readable shape emitted by `iudex status --json`.
// It is the stable contract the GUI client reads; fields may be added but
// existing ones should not change meaning.
type jsonWorkspace struct {
	MainBranch    string       `json:"mainBranch"`
	MaxActive     int          `json:"maxActive"`
	QARejectLimit int          `json:"qaRejectLimit"`
	Tickets       []jsonTicket `json:"tickets"`
}

// jsonTicket is one ticket's derived standing, including fields the caller
// cannot cheaply recompute without replicating the state machine (ready/blocked
// and the worktree path).
type jsonTicket struct {
	ID          string   `json:"id"`
	State       string   `json:"state"`
	Deps        []string `json:"deps"`
	QARejects   int      `json:"qaRejects"`
	Ready       bool     `json:"ready"`
	BlockedBy   []string `json:"blockedBy"`
	HasWorktree bool     `json:"hasWorktree"`
	Worktree    string   `json:"worktree,omitempty"`
}

// runStatusJSON emits every ticket in the workspace as JSON, ordered by ticket
// number. Unlike the human view it never hides done/removed tickets: the GUI is
// the source of filtering, so the read path always returns the whole truth.
func runStatusJSON(cmd *cobra.Command, ctx *wsContext) error {
	ids := make([]string, 0, len(ctx.Statuses))
	for id := range ctx.Statuses {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		ni, _ := ticket.ParseID(ids[i])
		nj, _ := ticket.ParseID(ids[j])
		return ni < nj
	})

	out := jsonWorkspace{
		MainBranch:    ctx.Config.MainBranch,
		MaxActive:     ctx.Config.MaxActive,
		QARejectLimit: ctx.Config.QARejectLimit,
		Tickets:       make([]jsonTicket, 0, len(ids)),
	}
	for _, id := range ids {
		s := ctx.Statuses[id]
		ready, blocking := ticket.DepsReady(s, ctx.Statuses)
		jt := jsonTicket{
			ID:          s.Ticket,
			State:       string(s.State),
			Deps:        append([]string{}, s.Deps...),
			QARejects:   s.QARejects,
			Ready:       ready,
			BlockedBy:   append([]string{}, blocking...),
			HasWorktree: ticket.HasWorktree(s.State),
		}
		if jt.HasWorktree {
			jt.Worktree = workspace.Worktree(ctx.Root, id)
		}
		out.Tickets = append(out.Tickets, jt)
	}

	enc := json.NewEncoder(cmd.OutOrStdout())
	enc.SetIndent("", "  ")
	return enc.Encode(out)
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
