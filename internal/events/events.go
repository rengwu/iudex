// Package events manages the append-only events.jsonl log, the sole source of
// truth for ticket state.
//
// Each line is a JSON state transition. Status, dependencies, and the QA-reject
// counter are all derived by replaying the log (see package ticket); nothing is
// stored anywhere else.
package events

import (
	"bufio"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"iudex/internal/workspace"
)

// Event is a single state transition for a ticket.
type Event struct {
	ID      string   `json:"id"`
	Ticket  string   `json:"ticket"`
	From    string   `json:"from"`
	To      string   `json:"to"`
	TS      string   `json:"ts"`
	Trigger string   `json:"trigger,omitempty"` // command that caused it, e.g. "queue", "qa-reject"
	Deps    []string `json:"deps,omitempty"`    // blocking dependencies, set on the queue event
	Reason  string   `json:"reason,omitempty"`  // optional human/agent note
}

// Append writes ev to events.jsonl, filling in a fresh ID and timestamp. The
// write uses O_APPEND so concurrent invocations are safe on POSIX filesystems.
// It returns the completed event.
func Append(root string, ev Event) (Event, error) {
	ev.ID = newUUID()
	ev.TS = time.Now().UTC().Format(time.RFC3339)

	line, err := json.Marshal(ev)
	if err != nil {
		return Event{}, err
	}
	f, err := os.OpenFile(workspace.EventsFile(root), os.O_APPEND|os.O_WRONLY|os.O_CREATE, 0o644)
	if err != nil {
		return Event{}, err
	}
	defer f.Close()
	if _, err := fmt.Fprintf(f, "%s\n", line); err != nil {
		return Event{}, err
	}
	return ev, nil
}

// ReadAll returns every event in the log, in order. Malformed lines are skipped.
// A missing log is treated as empty.
func ReadAll(root string) ([]Event, error) {
	f, err := os.Open(workspace.EventsFile(root))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var out []Event
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
		out = append(out, ev)
	}
	return out, scanner.Err()
}

func newUUID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
