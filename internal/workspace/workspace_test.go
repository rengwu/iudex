package workspace

import "testing"

// TestAgentCommandForRole pins the role->command resolution rule that is the
// single source of truth (CLI `agent-command`/`spawn` and any GUI consumer).
func TestAgentCommandForRole(t *testing.T) {
	cfg := &Config{
		AgentCommands: []AgentCommand{
			{Name: "pi", Command: "pi", Default: true},
			{Name: "claude", Command: "claude --x"},
		},
		AgentRoles: map[string]string{"qa": "claude"},
	}
	// An unmapped role (impl) and any arbitrary role (idea/resolve) fall back to
	// the default entry — the resolver treats the role as an opaque key.
	cases := map[string]string{
		"qa":      "claude --x",
		"impl":    "pi",
		"idea":    "pi",
		"resolve": "pi",
	}
	for role, want := range cases {
		if got := cfg.AgentCommandForRole(role); got != want {
			t.Errorf("AgentCommandForRole(%q) = %q, want %q", role, got, want)
		}
	}
}

// A role mapped to a pool name that no longer exists falls back to the default.
func TestAgentCommandForRoleStaleMapping(t *testing.T) {
	cfg := &Config{
		AgentCommands: []AgentCommand{{Name: "pi", Command: "pi", Default: true}},
		AgentRoles:    map[string]string{"qa": "gone"},
	}
	if got := cfg.AgentCommandForRole("qa"); got != "pi" {
		t.Errorf("AgentCommandForRole(qa) = %q, want pi (fallback to default)", got)
	}
}

func TestDefaultAgentCommand(t *testing.T) {
	// An explicit default wins over order.
	cfg := &Config{AgentCommands: []AgentCommand{
		{Name: "a", Command: "a"},
		{Name: "b", Command: "b", Default: true},
	}}
	if got := cfg.DefaultAgentCommand(); got != "b" {
		t.Errorf("DefaultAgentCommand = %q, want b", got)
	}
	// With no explicit default, the first entry is used.
	cfg = &Config{AgentCommands: []AgentCommand{{Name: "a", Command: "a"}, {Name: "b", Command: "b"}}}
	if got := cfg.DefaultAgentCommand(); got != "a" {
		t.Errorf("DefaultAgentCommand = %q, want a (first)", got)
	}
	// An empty pool resolves to "" — callers turn that into an error rather than
	// emitting a broken command.
	if got := (&Config{}).DefaultAgentCommand(); got != "" {
		t.Errorf("DefaultAgentCommand(empty) = %q, want empty", got)
	}
	if got := (&Config{}).AgentCommandForRole("impl"); got != "" {
		t.Errorf("AgentCommandForRole(empty) = %q, want empty", got)
	}
}

// migrate folds a legacy single agent_command into the pool as the default, so
// pre-pool workspaces resolve unchanged. (The GUI used to replicate this fold.)
func TestMigrateFoldsLegacyAgentCommand(t *testing.T) {
	cfg := &Config{LegacyAgentCommand: "claude --foo"}
	cfg.migrate()
	if len(cfg.AgentCommands) != 1 {
		t.Fatalf("got %d pool entries, want 1", len(cfg.AgentCommands))
	}
	if e := cfg.AgentCommands[0]; e.Name != "claude --foo" || e.Command != "claude --foo" || !e.Default {
		t.Errorf("folded entry = %+v, want name/command %q default", e, "claude --foo")
	}
	// A present pool is left untouched by migrate.
	cfg = &Config{
		AgentCommands:      []AgentCommand{{Name: "pi", Command: "pi", Default: true}},
		LegacyAgentCommand: "ignored",
	}
	cfg.migrate()
	if len(cfg.AgentCommands) != 1 || cfg.AgentCommands[0].Name != "pi" {
		t.Errorf("migrate clobbered an existing pool: %+v", cfg.AgentCommands)
	}
}
