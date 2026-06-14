package cmd

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"iudex/internal/events"
	"iudex/internal/ticket"
	"iudex/internal/workspace"
)

// newQueueCmd registers an authored ticket markdown file into the queue,
// recording its blocking dependencies in the event log. It rejects reused ids
// and deps that are not already registered (or are removed/failed).
func newQueueCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "queue <ticket-id>",
		Short: "Register a queued ticket and its dependencies",
		Args:  cobra.ExactArgs(1),
		RunE:  runQueue,
	}
	cmd.Flags().StringSlice("deps", nil, "comma-separated blocking ticket ids (must already be registered)")
	return cmd
}

func runQueue(cmd *cobra.Command, args []string) error {
	id := args[0]
	if _, ok := ticket.ParseID(id); !ok {
		return fmt.Errorf("invalid ticket id %q (expected form t<N>, e.g. t5)", id)
	}

	ctx, err := loadContext()
	if err != nil {
		return err
	}

	// The brief must already be authored in the queue directory.
	queueFile := workspace.QueueFile(ctx.Root, id)
	if _, err := os.Stat(queueFile); err != nil {
		if os.IsNotExist(err) {
			rel := filepath.Join(workspace.Dir, "queue", id+".md")
			return fmt.Errorf("no ticket file at %s — author the brief first", rel)
		}
		return err
	}

	// Ids are never reused.
	if s := ctx.Statuses[id]; s != nil {
		return fmt.Errorf("ticket %s is already registered (state: %s)", id, s.State)
	}

	deps, err := cmd.Flags().GetStringSlice("deps")
	if err != nil {
		return err
	}
	deps, err = validateDeps(id, deps, ctx.Statuses)
	if err != nil {
		return err
	}

	if _, err := events.Append(ctx.Root, events.Event{
		Ticket:  id,
		From:    string(ticket.StateNone),
		To:      string(ticket.StateQueued),
		Trigger: string(ticket.TriggerQueue),
		Deps:    deps,
	}); err != nil {
		return err
	}

	out := cmd.OutOrStdout()
	if len(deps) == 0 {
		fmt.Fprintf(out, "✓ queued %s (no dependencies)\n", id)
	} else {
		fmt.Fprintf(out, "✓ queued %s (depends on: %s)\n", id, strings.Join(deps, ", "))
	}
	return nil
}

// validateDeps de-duplicates the requested deps and verifies each is already
// registered and still able to reach done (not removed or failed). It returns
// the cleaned dep list.
func validateDeps(id string, deps []string, all map[string]*ticket.Status) ([]string, error) {
	seen := make(map[string]bool)
	var cleaned []string
	var bad []string
	for _, dep := range deps {
		dep = strings.TrimSpace(dep)
		if dep == "" || seen[dep] {
			continue
		}
		seen[dep] = true
		cleaned = append(cleaned, dep)

		switch d := all[dep]; {
		case dep == id:
			bad = append(bad, dep+" (cannot depend on itself)")
		case d == nil:
			bad = append(bad, dep+" (not registered)")
		case d.State == ticket.StateRemoved || d.State == ticket.StateFailed:
			bad = append(bad, fmt.Sprintf("%s (%s — cannot reach done)", dep, d.State))
		}
	}
	if len(bad) > 0 {
		return nil, fmt.Errorf("cannot queue %s: dependencies must already be registered and able to reach done: %s",
			id, strings.Join(bad, ", "))
	}
	return cleaned, nil
}
