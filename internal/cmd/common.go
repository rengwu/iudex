package cmd

import (
	"fmt"
	"io"
	"os"
	"path/filepath"

	"iudex/internal/events"
	"iudex/internal/ticket"
	"iudex/internal/workspace"
)

// wsContext bundles the resolved workspace, its config, and the state derived
// from its event log, which most commands need together.
type wsContext struct {
	Root     string
	Config   *workspace.Config
	Events   []events.Event
	Statuses map[string]*ticket.Status
}

// loadContext finds the workspace from the current directory, loads its config,
// reads its event log, and derives ticket statuses.
func loadContext() (*wsContext, error) {
	root, err := workspace.Find("")
	if err != nil {
		return nil, err
	}
	cfg, err := workspace.LoadConfig(root)
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
	return &wsContext{Root: root, Config: cfg, Events: evs, Statuses: statuses}, nil
}

// resolveTicket returns the explicit ticket id from args, or infers it from the
// current directory when inside a ticket worktree. Used by worktree-scoped
// commands (finish, qa, spawn).
func resolveTicket(root string, args []string) (string, error) {
	if len(args) == 1 {
		return args[0], nil
	}
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	id, ok := workspace.TicketFromCwd(root, cwd)
	if !ok {
		return "", fmt.Errorf("no ticket id given and not inside a ticket worktree")
	}
	return id, nil
}

// spawnCommand builds a ready-to-paste agent command that drops the user into a
// ticket's worktree with the given prompt template. iudex never runs it. The
// agent binary is resolved per role from the config's command pool; the prompt
// file identifies the role (review.md → qa, otherwise impl).
//
// It errors when no command resolves rather than emitting one with an empty
// binary slot: `cd … && "$(cat prompt)"` would make the shell execute the prompt
// text itself (a footgun seen when an old iudex reads a pool-format config).
func spawnCommand(root string, cfg *workspace.Config, id, promptFile string) (string, error) {
	role := "impl"
	if promptFile == "review.md" {
		role = "qa"
	}
	agent := cfg.AgentCommandForRole(role)
	if agent == "" {
		return "", fmt.Errorf("no agent command configured for role %q — add an entry under agent_commands in .iudex/config.yml", role)
	}
	wt := workspace.Worktree(root, id)
	prompt := filepath.Join(workspace.PromptsDir(root), promptFile)
	return fmt.Sprintf(`cd %s && %s "$(cat %s)"`, wt, agent, prompt), nil
}

// fprintSpawnHint writes the indented spawn command for a "next steps" block, or
// a short note when no agent command is configured — never a broken command.
func fprintSpawnHint(out io.Writer, root string, cfg *workspace.Config, id, promptFile string) {
	if c, err := spawnCommand(root, cfg, id, promptFile); err == nil {
		fmt.Fprintf(out, "    %s\n", c)
	} else {
		fmt.Fprintf(out, "    (%v)\n", err)
	}
}
