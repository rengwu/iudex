package config

import (
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

type Config struct {
	MaxAgents     int    `yaml:"max_agents"`
	StallTimeout  int    `yaml:"stall_timeout_minutes"`
	PollInterval  int    `yaml:"poll_interval_seconds"`
	AgentCommand  string `yaml:"agent_command"`
	MergeStrategy string `yaml:"merge_strategy"`
	ImplPrompt    string `yaml:"impl_prompt"`
	QAPrompt      string `yaml:"qa_prompt"`
}

var defaults = Config{
	MaxAgents:     3,
	StallTimeout:  10,
	PollInterval:  30,
	AgentCommand:  "pi dev",
	MergeStrategy: "squash",
	ImplPrompt:    "Read ../../../.iudex/impl.md and follow it to implement the ticket in .task/brief.md.",
	QAPrompt:      "Read ../../../.iudex/review.md and follow it to review the ticket in .task/brief.md.",
}

// FindWorkspace walks up from start (or CWD) looking for .iudex/config.yml.
func FindWorkspace(start string) (string, error) {
	if start == "" {
		var err error
		start, err = os.Getwd()
		if err != nil {
			return "", err
		}
	}
	dir, err := filepath.Abs(start)
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, ".iudex", "config.yml")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", fmt.Errorf("not inside an iudex workspace; run 'iudex init' first")
}

// Load reads and merges config.yml over defaults.
func Load(workspace string) (*Config, error) {
	data, err := os.ReadFile(filepath.Join(workspace, ".iudex", "config.yml"))
	if err != nil {
		return nil, err
	}
	cfg := defaults
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}

// Path helpers — single source of truth for workspace layout.

func QueueDir(workspace string) string {
	return filepath.Join(workspace, "queue")
}

func ArchiveDir(workspace string) string {
	return filepath.Join(workspace, "archive")
}

func WorktreesDir(workspace string) string {
	return filepath.Join(workspace, "project", "worktrees")
}

func MainWorktree(workspace string) string {
	return filepath.Join(WorktreesDir(workspace), "main")
}

func TaskWorktree(workspace, ticket string) string {
	return filepath.Join(WorktreesDir(workspace), ticket)
}

func TaskDir(workspace, ticket string) string {
	return filepath.Join(TaskWorktree(workspace, ticket), ".task")
}

func EventsFile(workspace string) string {
	return filepath.Join(workspace, "events.jsonl")
}
