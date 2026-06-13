// Package ticket defines the iudex ticket state machine and derives ticket
// status by replaying the event log.
//
// The event log (package events) is the sole source of truth. Nothing in here
// holds persistent state; every value is computed from the events.
package ticket

import (
	"errors"

	"iudex/internal/events"
)

// errNotImplemented marks scaffolded functions whose logic is still pending.
var errNotImplemented = errors.New("ticket: not implemented")

// State is a ticket lifecycle state.
type State string

const (
	StateNone           State = ""                 // never registered
	StateQueued         State = "queued"           // registered, awaiting activation
	StateActive         State = "active"           // worktree live, being implemented
	StatePendingQA      State = "pending-qa"       // awaiting agent QA
	StatePendingHumanQA State = "pending-human-qa" // QA-approved, awaiting human
	StateDone           State = "done"             // merged, archived, worktree removed
	StateFailed         State = "failed"           // hit qa_reject_limit; needs intervention
	StateRemoved        State = "removed"          // abandoned, archived, worktree removed
)

// Trigger is a command-driven transition cause, recorded on each event.
type Trigger string

const (
	TriggerQueue          Trigger = "queue"
	TriggerActivate       Trigger = "activate"
	TriggerFinish         Trigger = "finish"
	TriggerQAApprove      Trigger = "qa-approve"
	TriggerQAReject       Trigger = "qa-reject"
	TriggerHumanQAApprove Trigger = "human-qa-approve"
	TriggerHumanQAReject  Trigger = "human-qa-reject"
	TriggerRetry          Trigger = "retry"
	TriggerRemove         Trigger = "remove"
)

// IsTerminal reports whether a state has no outgoing transitions.
func IsTerminal(s State) bool {
	return s == StateDone || s == StateRemoved
}

// HasWorktree reports whether a state implies a live worktree on disk.
func HasWorktree(s State) bool {
	switch s {
	case StateActive, StatePendingQA, StatePendingHumanQA, StateFailed:
		return true
	default:
		return false
	}
}

// Status is the derived current standing of a single ticket.
type Status struct {
	Ticket    string
	State     State
	Deps      []string // blocking deps registered at queue time
	QARejects int      // cumulative qa-reject count since the last activation/retry
}

// Derive replays the event log and returns the current status of every ticket.
//
// TODO(scaffold): implement replay — track latest state, carry Deps from the
// queue event, and count TriggerQAReject occurrences since the most recent
// TriggerActivate/TriggerRetry to produce QARejects.
func Derive(evs []events.Event) (map[string]*Status, error) {
	return nil, errNotImplemented
}

// DepsReady reports whether every dependency of status is Done according to the
// derived status map, plus the list of deps that are still blocking.
//
// TODO(scaffold): implement.
func DepsReady(status *Status, all map[string]*Status) (ready bool, blocking []string) {
	return false, nil
}

// MaxID returns the highest ticket number ever registered in the log, or 0 if
// none. Used by `iudex next-ticket-id` and reuse validation.
//
// TODO(scaffold): implement (parse the "t<N>" ticket ids from the log).
func MaxID(evs []events.Event) (int, error) {
	return 0, errNotImplemented
}
