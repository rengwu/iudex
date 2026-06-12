// Package orchestrator runs the background loop that claims tickets and monitors agents.
//
// Responsibilities:
//   - Claim unclaimed tickets from queue/ (creates worktree, moves brief into .task/)
//   - Monitor active worktrees for stalled agents (no commits in N minutes)
//   - Auto-commit dirty worktrees before QA handoff
//   - Surface spawn commands to the TUI
//
// Not responsible for:
//   - Merging to main        (human decision via CLI)
//   - Task bundling          (deferred to v2)
//   - Launching agent process (human runs the command)
package orchestrator

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"strings"

	"iudex/internal/config"
	"iudex/internal/events"
	"iudex/internal/git"
)

// SpawnCommand is a ready-to-run agent command surfaced to the TUI.
type SpawnCommand struct {
	Ticket  string
	Command string
	Role    string // "impl" or "qa"
}

// Orchestrator manages the background polling loop.
type Orchestrator struct {
	workspace string
	cfg       *config.Config

	mu            sync.Mutex
	Alerts        []string
	SpawnCommands []SpawnCommand

	updates chan struct{} // non-blocking send; TUI listens on this
	stop    chan struct{}
	wg      sync.WaitGroup
}

// New creates a new Orchestrator. Call Start() to begin polling.
func New(workspace string, cfg *config.Config) *Orchestrator {
	return &Orchestrator{
		workspace: workspace,
		cfg:       cfg,
		updates:   make(chan struct{}, 1),
		stop:      make(chan struct{}),
	}
}

// Start launches the background goroutine.
func (o *Orchestrator) Start() {
	o.wg.Add(1)
	go func() {
		defer o.wg.Done()
		ticker := time.NewTicker(time.Duration(o.cfg.PollInterval) * time.Second)
		defer ticker.Stop()
		o.tick() // immediate first tick
		for {
			select {
			case <-ticker.C:
				o.tick()
			case <-o.stop:
				return
			}
		}
	}()
}

// Stop signals the goroutine and waits for it to exit.
func (o *Orchestrator) Stop() {
	close(o.stop)
	o.wg.Wait()
}

// Updates returns the channel the TUI should listen on for state changes.
func (o *Orchestrator) Updates() <-chan struct{} {
	return o.updates
}

// GetState returns a snapshot of current alerts and spawn commands.
func (o *Orchestrator) GetState() (alerts []string, cmds []SpawnCommand) {
	o.mu.Lock()
	defer o.mu.Unlock()
	alerts = make([]string, len(o.Alerts))
	copy(alerts, o.Alerts)
	cmds = make([]SpawnCommand, len(o.SpawnCommands))
	copy(cmds, o.SpawnCommands)
	return
}

// DismissAlerts clears all current alerts.
func (o *Orchestrator) DismissAlerts() {
	o.mu.Lock()
	o.Alerts = nil
	o.mu.Unlock()
}

// DismissSpawnCommand removes the spawn command for a given ticket.
func (o *Orchestrator) DismissSpawnCommand(ticket string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	filtered := o.SpawnCommands[:0]
	for _, sc := range o.SpawnCommands {
		if sc.Ticket != ticket {
			filtered = append(filtered, sc)
		}
	}
	o.SpawnCommands = filtered
}

// ---------------------------------------------------------------------------
// Internal loop
// ---------------------------------------------------------------------------

func (o *Orchestrator) tick() {
	tickets, err := events.GetAllTickets(o.workspace)
	if err != nil {
		o.alert(fmt.Sprintf("orchestrator: read events: %v", err))
		return
	}

	activeCount := 0
	for _, state := range tickets {
		if events.ActiveStates[state] {
			activeCount++
		}
	}

	// Claim queued tickets up to max_agents.
	queueDir := config.QueueDir(o.workspace)
	matches, _ := filepath.Glob(filepath.Join(queueDir, "ticket-*.md"))
	for _, ticketFile := range matches {
		if activeCount >= o.cfg.MaxAgents {
			break
		}
		ticket := strings.TrimSuffix(filepath.Base(ticketFile), ".md")
		state := tickets[ticket]
		if state != "" && state != "queued" && state != "rejected" {
			continue
		}
		if err := o.claimTicket(ticket, ticketFile); err != nil {
			o.alert(fmt.Sprintf("claim %s: %v", ticket, err))
			continue
		}
		activeCount++
		o.notify()
	}

	// Check for stalled agents.
	for ticket, state := range tickets {
		if !events.ActiveStates[state] {
			continue
		}
		wt := config.TaskWorktree(o.workspace, ticket)
		if _, err := os.Stat(wt); os.IsNotExist(err) {
			continue
		}
		if git.IsStalled(o.workspace, ticket, o.cfg.StallTimeout) {
			msg := fmt.Sprintf("⚠  %s stalled — no commits in %dm", ticket, o.cfg.StallTimeout)
			o.mu.Lock()
			found := false
			for _, a := range o.Alerts {
				if a == msg {
					found = true
					break
				}
			}
			if !found {
				o.Alerts = append(o.Alerts, msg)
			}
			o.mu.Unlock()
			o.notify()
		}
	}

	// Auto-commit dirty worktrees about to enter QA.
	for ticket, state := range tickets {
		if state != "pending-review" {
			continue
		}
		wt := config.TaskWorktree(o.workspace, ticket)
		if _, err := os.Stat(wt); os.IsNotExist(err) {
			continue
		}
		if clean, err := git.IsClean(o.workspace, ticket); err == nil && !clean {
			if err := git.WIPCommit(o.workspace, ticket); err == nil {
				o.alert(fmt.Sprintf("ℹ  auto-committed WIP for %s before QA", ticket))
			}
		}
	}

	// Surface QA spawn commands for pending-review tickets.
	for ticket, state := range tickets {
		if state != "pending-review" {
			continue
		}
		o.mu.Lock()
		already := false
		for _, sc := range o.SpawnCommands {
			if sc.Ticket == ticket && sc.Role == "qa" {
				already = true
				break
			}
		}
		o.mu.Unlock()
		if already {
			continue
		}
		cmd := spawnCmd(ticket, o.cfg.AgentCommand, o.cfg.QAPrompt)
		o.mu.Lock()
		o.SpawnCommands = append(o.SpawnCommands, SpawnCommand{Ticket: ticket, Command: cmd, Role: "qa"})
		o.mu.Unlock()
		o.notify()
	}
}

func (o *Orchestrator) claimTicket(ticket, ticketFile string) error {
	wt, err := git.CreateWorktree(o.workspace, ticket)
	if err != nil {
		return err
	}

	taskDir := filepath.Join(wt, ".task")
	if err := os.MkdirAll(taskDir, 0o755); err != nil {
		return err
	}

	// Move brief from queue → .task/brief.md
	if err := copyFile(ticketFile, filepath.Join(taskDir, "brief.md")); err != nil {
		return err
	}

	// Initialise session log
	logContent := fmt.Sprintf(
		"# Session Log: %s\n\n_Append notes as you work — decisions, gotchas, tests, handoff instructions._\n\n",
		ticket,
	)
	if err := os.WriteFile(filepath.Join(taskDir, "log.md"), []byte(logContent), 0o644); err != nil {
		return err
	}

	// Atomic claim: remove ticket from queue
	if err := os.Remove(ticketFile); err != nil {
		return err
	}

	if _, err := events.Append(o.workspace, ticket, "queued", "in-progress", ""); err != nil {
		return err
	}

	cmd := spawnCmd(ticket, o.cfg.AgentCommand, o.cfg.ImplPrompt)
	o.mu.Lock()
	o.SpawnCommands = append(o.SpawnCommands, SpawnCommand{Ticket: ticket, Command: cmd, Role: "impl"})
	o.mu.Unlock()

	return nil
}

func (o *Orchestrator) alert(msg string) {
	o.mu.Lock()
	o.Alerts = append(o.Alerts, msg)
	o.mu.Unlock()
	o.notify()
}

func (o *Orchestrator) notify() {
	select {
	case o.updates <- struct{}{}:
	default: // TUI hasn't consumed the last signal yet; that's fine
	}
}

func spawnCmd(ticket, agentCommand, prompt string) string {
	if prompt == "" {
		return fmt.Sprintf("cd project/worktrees/%s && %s", ticket, agentCommand)
	}
	return fmt.Sprintf(`cd project/worktrees/%s && %s "%s"`, ticket, agentCommand, prompt)
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}
