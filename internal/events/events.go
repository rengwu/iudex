// Package events manages the append-only events.jsonl state machine.
//
// Each line is a JSON state transition:
//
//	{"id":"uuid","ticket":"ticket-00001","from":"queued","to":"in-progress","ts":"...","note":"..."}
//
// Valid states:
//
//	queued               ticket is in queue/, unclaimed
//	in-progress          impl agent is working in worktree
//	pending-review       QA agent is reviewing in same worktree
//	pending-human-review QA done, waiting for human decision
//	human-manual         human has taken over the worktree
//	done                 approved, merged, archived, worktree removed
//	rejected             rejected by human, archived, worktree removed
package events

import (
	"bufio"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"llm-flow/internal/config"
)

// Event represents a single state transition.
type Event struct {
	ID     string `json:"id"`
	Ticket string `json:"ticket"`
	From   string `json:"from"`
	To     string `json:"to"`
	TS     string `json:"ts"`
	Note   string `json:"note,omitempty"`
}

// ActiveStates is the set of states where a worktree is occupied.
var ActiveStates = map[string]bool{
	"in-progress":    true,
	"pending-review": true,
	"human-manual":   true,
}

// Append writes a new state transition to events.jsonl atomically (O_APPEND).
func Append(workspace, ticket, from, to, note string) (Event, error) {
	ev := Event{
		ID:     newUUID(),
		Ticket: ticket,
		From:   from,
		To:     to,
		TS:     time.Now().UTC().Format(time.RFC3339),
		Note:   note,
	}
	line, err := json.Marshal(ev)
	if err != nil {
		return Event{}, err
	}
	f, err := os.OpenFile(
		config.EventsFile(workspace),
		os.O_APPEND|os.O_WRONLY|os.O_CREATE,
		0o644,
	)
	if err != nil {
		return Event{}, err
	}
	defer f.Close()
	_, err = fmt.Fprintf(f, "%s\n", line)
	return ev, err
}

// GetTicketState returns the current state of a ticket by replaying events.jsonl.
func GetTicketState(workspace, ticket string) (string, error) {
	states, err := replayStates(workspace, ticket)
	if err != nil {
		return "", err
	}
	return states[ticket], nil
}

// GetAllTickets returns a map of ticket → current state for every known ticket.
func GetAllTickets(workspace string) (map[string]string, error) {
	return replayStates(workspace, "")
}

// GetTicketEvents returns all events for a specific ticket in order.
func GetTicketEvents(workspace, ticket string) ([]Event, error) {
	f, err := os.Open(config.EventsFile(workspace))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var result []Event
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}
		var ev Event
		if json.Unmarshal([]byte(line), &ev) != nil {
			continue // skip malformed lines silently
		}
		if ev.Ticket == ticket {
			result = append(result, ev)
		}
	}
	return result, scanner.Err()
}

// replayStates scans events.jsonl and returns the latest state per ticket.
// If filterTicket is non-empty, only that ticket's events are considered.
func replayStates(workspace, filterTicket string) (map[string]string, error) {
	f, err := os.Open(config.EventsFile(workspace))
	if os.IsNotExist(err) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()

	states := make(map[string]string)
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}
		var ev Event
		if json.Unmarshal([]byte(line), &ev) != nil {
			continue
		}
		if filterTicket == "" || ev.Ticket == filterTicket {
			states[ev.Ticket] = ev.To
		}
	}
	return states, scanner.Err()
}

func newUUID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
