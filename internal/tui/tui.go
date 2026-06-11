// Package tui implements the Bubble Tea TUI: fleet monitor and spawn launcher.
//
// Panels: SPAWN, QUEUE, ACTIVE, AWAITING REVIEW, ALERTS
// Keys:   r=refresh, a=dismiss alerts, q=quit
package tui

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"llm-flow/internal/config"
	"llm-flow/internal/events"
	"llm-flow/internal/git"
	"llm-flow/internal/orchestrator"
)

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

var (
	bold     = lipgloss.NewStyle().Bold(true)
	dim      = lipgloss.NewStyle().Foreground(lipgloss.Color("240"))
	green    = lipgloss.NewStyle().Foreground(lipgloss.Color("82"))
	yellow   = lipgloss.NewStyle().Foreground(lipgloss.Color("220"))
	red      = lipgloss.NewStyle().Foreground(lipgloss.Color("196"))
	blue     = lipgloss.NewStyle().Foreground(lipgloss.Color("75"))
	cyan     = lipgloss.NewStyle().Foreground(lipgloss.Color("86"))
	boldCyan = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("86"))

	panel = lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("238")).
		Padding(0, 1).
		MarginBottom(1)

	spawnPanel  = panel.Copy().BorderForeground(lipgloss.Color("82"))
	reviewPanel = panel.Copy().BorderForeground(lipgloss.Color("220"))
	alertPanel  = panel.Copy().BorderForeground(lipgloss.Color("196"))
)

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

type tickMsg struct{}
type orchMsg struct{}

type refreshedMsg struct {
	queueFiles []string
	tickets    map[string]string
	commitInfo map[string]commitSummary
}

type commitSummary struct {
	count int
	ago   string
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

// Model is the Bubble Tea model. Implements tea.Model.
type Model struct {
	workspace string
	orch      *orchestrator.Orchestrator
	cfg       *config.Config

	// derived state, refreshed on tick
	queueFiles []string
	tickets    map[string]string
	commitInfo map[string]commitSummary
	alerts     []string
	spawnCmds  []orchestrator.SpawnCommand
	lastUpdate time.Time
}

func newModel(workspace string, cfg *config.Config, orch *orchestrator.Orchestrator) Model {
	return Model{
		workspace:  workspace,
		cfg:        cfg,
		orch:       orch,
		tickets:    make(map[string]string),
		commitInfo: make(map[string]commitSummary),
	}
}

func (m Model) Init() tea.Cmd {
	return tea.Batch(
		m.refreshCmd(),
		tickCmd(),
		waitForOrch(m.orch.Updates()),
	)
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "q", "ctrl+c":
			return m, tea.Quit
		case "r":
			return m, m.refreshCmd()
		case "a":
			m.orch.DismissAlerts()
			m.alerts = nil
		}

	case tickMsg:
		return m, tea.Batch(m.refreshCmd(), tickCmd())

	case orchMsg:
		m.alerts, m.spawnCmds = m.orch.GetState()
		return m, waitForOrch(m.orch.Updates())

	case refreshedMsg:
		m.queueFiles = msg.queueFiles
		m.tickets = msg.tickets
		m.commitInfo = msg.commitInfo
		m.lastUpdate = time.Now()
		m.alerts, m.spawnCmds = m.orch.GetState()
	}
	return m, nil
}

func (m Model) View() string {
	var sections []string

	if s := m.viewSpawn(); s != "" {
		sections = append(sections, s)
	}
	sections = append(sections, m.viewQueue())
	sections = append(sections, m.viewActive())
	sections = append(sections, m.viewReview())
	if s := m.viewAlerts(); s != "" {
		sections = append(sections, s)
	}

	footer := dim.Render(fmt.Sprintf(
		" r refresh · a dismiss alerts · q quit   updated %s",
		m.lastUpdate.Format("15:04:05"),
	))
	return strings.Join(sections, "\n") + "\n" + footer
}

// ---------------------------------------------------------------------------
// View helpers
// ---------------------------------------------------------------------------

func (m Model) viewSpawn() string {
	if len(m.spawnCmds) == 0 {
		return ""
	}
	lines := []string{bold.Render("SPAWN") + "  " + dim.Render("run each in a new terminal:")}
	for _, sc := range m.spawnCmds {
		lines = append(lines, fmt.Sprintf("  %s  %s  %s",
			green.Render(sc.Ticket),
			dim.Render("→"),
			boldCyan.Render(sc.Command),
		))
	}
	return spawnPanel.Render(strings.Join(lines, "\n"))
}

func (m Model) viewQueue() string {
	if len(m.queueFiles) == 0 {
		return panel.Render(bold.Render("QUEUE") + "  " + dim.Render("(empty)"))
	}
	lines := []string{fmt.Sprintf("%s  %s",
		bold.Render("QUEUE"),
		dim.Render(fmt.Sprintf("%d ticket(s) waiting", len(m.queueFiles))),
	)}
	for _, f := range m.queueFiles {
		name := strings.TrimSuffix(filepath.Base(f), ".md")
		lines = append(lines, fmt.Sprintf("  %s  %s",
			dim.Render(name),
			truncate(readFirstLine(f), 55),
		))
	}
	return panel.Render(strings.Join(lines, "\n"))
}

func (m Model) viewActive() string {
	type entry struct{ ticket, state string }
	var active []entry
	for t, s := range m.tickets {
		if events.ActiveStates[s] {
			active = append(active, entry{t, s})
		}
	}
	if len(active) == 0 {
		return panel.Render(bold.Render("ACTIVE") + "  " + dim.Render("(none)"))
	}
	lines := []string{fmt.Sprintf("%s  %s",
		bold.Render("ACTIVE"),
		dim.Render(fmt.Sprintf("%d/%d agents", len(active), m.cfg.MaxAgents)),
	)}
	for _, e := range active {
		info := m.commitInfo[e.ticket]
		var icon, stateStr string
		switch e.state {
		case "in-progress":
			icon, stateStr = "⚙", blue.Render(e.state)
		case "pending-review":
			icon, stateStr = "🔍", yellow.Render(e.state)
		case "human-manual":
			icon, stateStr = "👤", cyan.Render(e.state)
		default:
			icon, stateStr = "·", e.state
		}
		lines = append(lines, fmt.Sprintf("  %s %s  %s  %s",
			icon, bold.Render(e.ticket), stateStr,
			dim.Render(fmt.Sprintf("%d commit(s) · last %s", info.count, info.ago)),
		))
	}
	return panel.Render(strings.Join(lines, "\n"))
}

func (m Model) viewReview() string {
	var pending []string
	for t, s := range m.tickets {
		if s == "pending-human-review" {
			pending = append(pending, t)
		}
	}
	if len(pending) == 0 {
		return reviewPanel.Render(bold.Render("AWAITING REVIEW") + "  " + dim.Render("(none)"))
	}
	lines := []string{fmt.Sprintf("%s  %s",
		bold.Render("AWAITING REVIEW"),
		yellow.Render(fmt.Sprintf("%d ticket(s)", len(pending))),
	)}
	for _, t := range pending {
		lines = append(lines, fmt.Sprintf("  → %s  %s",
			yellow.Render(t),
			dim.Render("llm-flow review "+t),
		))
	}
	return reviewPanel.Render(strings.Join(lines, "\n"))
}

func (m Model) viewAlerts() string {
	if len(m.alerts) == 0 {
		return ""
	}
	lines := []string{bold.Render("ALERTS") + "  " + dim.Render("press [a] to dismiss")}
	recent := m.alerts
	if len(recent) > 5 {
		recent = recent[len(recent)-5:]
	}
	for _, a := range recent {
		lines = append(lines, "  "+red.Render(a))
	}
	return alertPanel.Render(strings.Join(lines, "\n"))
}

// ---------------------------------------------------------------------------
// Cmds
// ---------------------------------------------------------------------------

func tickCmd() tea.Cmd {
	return tea.Tick(15*time.Second, func(time.Time) tea.Msg { return tickMsg{} })
}

func waitForOrch(ch <-chan struct{}) tea.Cmd {
	return func() tea.Msg {
		<-ch
		return orchMsg{}
	}
}

func (m Model) refreshCmd() tea.Cmd {
	workspace := m.workspace
	return func() tea.Msg {
		queueDir := config.QueueDir(workspace)
		queueFiles, _ := filepath.Glob(filepath.Join(queueDir, "ticket-*.md"))

		tickets, _ := events.GetAllTickets(workspace)

		commitInfo := make(map[string]commitSummary)
		for ticket, state := range tickets {
			if !events.ActiveStates[state] {
				continue
			}
			count, _ := git.GetCommitCount(workspace, ticket)
			lastTime, _ := git.GetLastCommitTime(workspace, ticket)
			ago := "no commits"
			if !lastTime.IsZero() {
				ago = humanDuration(time.Since(lastTime))
			}
			commitInfo[ticket] = commitSummary{count: count, ago: ago}
		}

		return refreshedMsg{
			queueFiles: queueFiles,
			tickets:    tickets,
			commitInfo: commitInfo,
		}
	}
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

func humanDuration(d time.Duration) string {
	mins := int(d.Minutes())
	if mins < 1 {
		return "just now"
	}
	if mins < 60 {
		return fmt.Sprintf("%dm ago", mins)
	}
	return fmt.Sprintf("%dh%dm ago", mins/60, mins%60)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}

func readFirstLine(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	lines := strings.SplitN(strings.TrimSpace(string(data)), "\n", 2)
	return strings.TrimPrefix(lines[0], "# ")
}

// Run initializes and starts the TUI with the background orchestrator.
func Run(workspace string) error {
	cfg, err := config.Load(workspace)
	if err != nil {
		return err
	}
	orch := orchestrator.New(workspace, cfg)
	orch.Start()
	defer orch.Stop()

	m := newModel(workspace, cfg, orch)
	p := tea.NewProgram(m, tea.WithAltScreen())
	return p.Start()
}
