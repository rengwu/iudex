// Package workspace handles discovery of the iudex workspace root and provides
// path helpers and configuration loading.
//
// A workspace is any directory containing an .iudex/config.yml. All iudex state
// lives under that single .iudex/ directory, which is gitignored.
package workspace

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// Dir is the name of the directory holding all iudex state, relative to the
// workspace root.
const Dir = ".iudex"

// AgentCommand is one named entry in the agent-command pool. Exactly one entry
// is the Default; roles without an explicit mapping use it.
type AgentCommand struct {
	Name    string `yaml:"name"`
	Command string `yaml:"command"`
	Default bool   `yaml:"default,omitempty"`
}

// Config mirrors .iudex/config.yml.
type Config struct {
	MainBranch    string `yaml:"main_branch"`
	MaxActive     int    `yaml:"max_active"`
	QARejectLimit int    `yaml:"qa_reject_limit"`
	// AgentCommands is the pool of named agent commands; AgentRoles maps a role
	// (impl, qa, resolve, idea, …) to a pool entry's name. The map is open by
	// design — unknown roles are ignored by consumers that don't use them.
	AgentCommands        []AgentCommand    `yaml:"agent_commands"`
	AgentRoles           map[string]string `yaml:"agent_roles"`
	MergeStrategy        string            `yaml:"merge_strategy"`
	MergeMessageTemplate string            `yaml:"merge_message_template"`
	BranchPrefix         string            `yaml:"branch_prefix"`

	// LegacyAgentCommand is the pre-pool single `agent_command`. It is folded
	// into the pool on load (see migrate) so old workspaces keep working.
	LegacyAgentCommand string `yaml:"agent_command,omitempty"`
}

// migrate folds a legacy single agent_command into the pool when no pool is
// present, so pre-pool workspaces resolve commands unchanged.
func (c *Config) migrate() {
	if len(c.AgentCommands) == 0 && c.LegacyAgentCommand != "" {
		c.AgentCommands = []AgentCommand{
			{Name: c.LegacyAgentCommand, Command: c.LegacyAgentCommand, Default: true},
		}
	}
}

// DefaultAgentCommand returns the command of the entry marked default, else the
// first entry, else "".
func (c *Config) DefaultAgentCommand() string {
	for _, a := range c.AgentCommands {
		if a.Default {
			return a.Command
		}
	}
	if len(c.AgentCommands) > 0 {
		return c.AgentCommands[0].Command
	}
	return ""
}

// AgentCommandForRole resolves the command for a role: the role's mapped pool
// entry by name, falling back to the default entry when the role is unmapped or
// names an entry that no longer exists.
func (c *Config) AgentCommandForRole(role string) string {
	if name := c.AgentRoles[role]; name != "" {
		for _, a := range c.AgentCommands {
			if a.Name == name {
				return a.Command
			}
		}
	}
	return c.DefaultAgentCommand()
}

// Find walks up from start (or the cwd when start is "") looking for a directory
// that contains .iudex/config.yml, and returns that directory (the workspace
// root). It works the same way git locates a repository from a subdirectory,
// so it resolves correctly from inside a ticket worktree too.
func Find(start string) (string, error) {
	dir := start
	if dir == "" {
		cwd, err := os.Getwd()
		if err != nil {
			return "", err
		}
		dir = cwd
	}
	dir, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, Dir, "config.yml")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("not inside an iudex workspace (no %s/config.yml found)", Dir)
		}
		dir = parent
	}
}

// LoadConfig reads and parses .iudex/config.yml for the given workspace root.
func LoadConfig(root string) (*Config, error) {
	data, err := os.ReadFile(ConfigFile(root))
	if err != nil {
		return nil, err
	}
	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	cfg.migrate()
	return &cfg, nil
}

// ---------------------------------------------------------------------------
// Path helpers — all relative to the workspace root.
// ---------------------------------------------------------------------------

// IudexDir returns <root>/.iudex.
func IudexDir(root string) string { return filepath.Join(root, Dir) }

// ConfigFile returns <root>/.iudex/config.yml.
func ConfigFile(root string) string { return filepath.Join(root, Dir, "config.yml") }

// EventsFile returns <root>/.iudex/events.jsonl.
func EventsFile(root string) string { return filepath.Join(root, Dir, "events.jsonl") }

// QueueDir returns <root>/.iudex/queue.
func QueueDir(root string) string { return filepath.Join(root, Dir, "queue") }

// ArchiveDir returns <root>/.iudex/archive.
func ArchiveDir(root string) string { return filepath.Join(root, Dir, "archive") }

// WorktreesDir returns <root>/.iudex/worktrees.
func WorktreesDir(root string) string { return filepath.Join(root, Dir, "worktrees") }

// PromptsDir returns <root>/.iudex/prompts.
func PromptsDir(root string) string { return filepath.Join(root, Dir, "prompts") }

// QueueFile returns the authored markdown path for a ticket in the queue.
func QueueFile(root, ticket string) string {
	return filepath.Join(QueueDir(root), ticket+".md")
}

// Worktree returns the worktree directory for a ticket.
func Worktree(root, ticket string) string {
	return filepath.Join(WorktreesDir(root), ticket)
}

// TaskDir returns the .task directory inside a ticket's worktree.
func TaskDir(root, ticket string) string {
	return filepath.Join(Worktree(root, ticket), ".task")
}

// ArchiveTicketDir returns the archive directory for a ticket.
func ArchiveTicketDir(root, ticket string) string {
	return filepath.Join(ArchiveDir(root), ticket)
}

// TicketFromCwd resolves the ticket whose worktree contains cwd, returning the
// ticket id and true when cwd is inside <root>/.iudex/worktrees/<id>/…
func TicketFromCwd(root, cwd string) (string, bool) {
	rel, err := filepath.Rel(WorktreesDir(root), cwd)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false
	}
	id := strings.SplitN(rel, string(filepath.Separator), 2)[0]
	if id == "" {
		return "", false
	}
	return id, true
}
