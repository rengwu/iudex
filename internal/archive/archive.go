// Package archive preserves a ticket's .task/ context, final diff, and metadata
// under .iudex/archive/<ticket>/ when it reaches a terminal state.
package archive

import (
	"errors"

	"iudex/internal/events"
)

// errNotImplemented marks scaffolded functions whose logic is still pending.
var errNotImplemented = errors.New("archive: not implemented")

// Meta is the contents of archive/<ticket>/meta.json.
type Meta struct {
	Ticket      string         `json:"ticket"`
	Outcome     string         `json:"outcome"` // "done" | "removed"
	ArchivedAt  string         `json:"archived_at"`
	MergeCommit string         `json:"merge_commit,omitempty"`
	QARejects   int            `json:"qa_rejects"`
	Events      []events.Event `json:"events"`
}

// Archive copies brief.md, log.md, and review.md (if present) from the ticket's
// .task/ into .iudex/archive/<ticket>/, writes diff.patch and meta.json, and
// returns the archive directory path.
//
// TODO(scaffold): implement.
func Archive(root, ticket, outcome, mergeCommit string, qaRejects int, evs []events.Event) (string, error) {
	return "", errNotImplemented
}
