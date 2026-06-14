// Package archive preserves a ticket's .task/ context, final diff, and metadata
// under .iudex/archive/<ticket>/ when it reaches a terminal state.
package archive

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"iudex/internal/events"
	"iudex/internal/workspace"
)

// Meta is the contents of archive/<ticket>/meta.json.
type Meta struct {
	Ticket      string         `json:"ticket"`
	Outcome     string         `json:"outcome"` // "done" | "removed"
	ArchivedAt  string         `json:"archived_at"`
	MergeCommit string         `json:"merge_commit,omitempty"`
	QARejects   int            `json:"qa_rejects"`
	Events      []events.Event `json:"events"`
}

// Archive copies brief.md, log.md, and review.md (whichever exist) from the
// ticket's .task/ into .iudex/archive/<ticket>/, writes diff.patch and
// meta.json, and returns the archive directory.
func Archive(root, ticket, outcome, mergeCommit, diff string, qaRejects int, evs []events.Event) (string, error) {
	dir := workspace.ArchiveTicketDir(root, ticket)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}

	taskDir := workspace.TaskDir(root, ticket)
	for _, name := range []string{"brief.md", "log.md", "review.md"} {
		data, err := os.ReadFile(filepath.Join(taskDir, name))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return "", err
		}
		if err := os.WriteFile(filepath.Join(dir, name), data, 0o644); err != nil {
			return "", err
		}
	}

	if err := os.WriteFile(filepath.Join(dir, "diff.patch"), []byte(diff), 0o644); err != nil {
		return "", err
	}

	meta := Meta{
		Ticket:      ticket,
		Outcome:     outcome,
		ArchivedAt:  time.Now().UTC().Format(time.RFC3339),
		MergeCommit: mergeCommit,
		QARejects:   qaRejects,
		Events:      evs,
	}
	b, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), b, 0o644); err != nil {
		return "", err
	}

	return dir, nil
}
