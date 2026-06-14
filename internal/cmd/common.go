package cmd

import (
	"iudex/internal/events"
	"iudex/internal/ticket"
	"iudex/internal/workspace"
)

// wsContext bundles the resolved workspace and the state derived from its event
// log, which most commands need together.
type wsContext struct {
	Root     string
	Events   []events.Event
	Statuses map[string]*ticket.Status
}

// loadContext finds the workspace from the current directory, reads its event
// log, and derives ticket statuses.
func loadContext() (*wsContext, error) {
	root, err := workspace.Find("")
	if err != nil {
		return nil, err
	}
	evs, err := events.ReadAll(root)
	if err != nil {
		return nil, err
	}
	statuses, err := ticket.Derive(evs)
	if err != nil {
		return nil, err
	}
	return &wsContext{Root: root, Events: evs, Statuses: statuses}, nil
}
