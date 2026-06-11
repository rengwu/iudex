// Package git wraps git CLI operations for worktree management.
// All operations use exec.Command("git", ...) against the system git binary.
package git

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"llm-flow/internal/config"
)

// run executes a git command in cwd and returns trimmed stdout.
func run(cwd string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = cwd
	out, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return "", fmt.Errorf("git %s: %s",
				strings.Join(args, " "),
				strings.TrimSpace(string(exitErr.Stderr)))
		}
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// CreateWorktree creates a new git worktree for ticket on a fresh branch from main.
func CreateWorktree(workspace, ticket string) (string, error) {
	main := config.MainWorktree(workspace)
	dest := config.TaskWorktree(workspace, ticket)
	branch := "work/" + ticket
	if _, err := run(main, "worktree", "add", "-b", branch, dest, "main"); err != nil {
		return "", fmt.Errorf("create worktree: %w", err)
	}
	ensureTaskGitignored(dest)
	return dest, nil
}

// RemoveWorktree removes the worktree directory and deletes its branch.
func RemoveWorktree(workspace, ticket string) {
	main := config.MainWorktree(workspace)
	dest := config.TaskWorktree(workspace, ticket)
	run(main, "worktree", "remove", dest, "--force") // best-effort
	run(main, "branch", "-D", "work/"+ticket)         // best-effort
}

// IsClean returns true when the worktree has no uncommitted changes.
func IsClean(workspace, ticket string) (bool, error) {
	out, err := run(config.TaskWorktree(workspace, ticket), "status", "--porcelain")
	if err != nil {
		return false, err
	}
	return out == "", nil
}

// GetLastCommitTime returns the timestamp of the most recent commit in the worktree.
func GetLastCommitTime(workspace, ticket string) (time.Time, error) {
	wt := config.TaskWorktree(workspace, ticket)
	if _, err := os.Stat(wt); os.IsNotExist(err) {
		return time.Time{}, nil
	}
	out, err := run(wt, "log", "-1", "--format=%aI")
	if err != nil || out == "" {
		return time.Time{}, err
	}
	return time.Parse(time.RFC3339, out)
}

// IsStalled returns true when there have been no commits in timeoutMinutes.
func IsStalled(workspace, ticket string, timeoutMinutes int) bool {
	t, err := GetLastCommitTime(workspace, ticket)
	if err != nil || t.IsZero() {
		return true
	}
	return time.Since(t) > time.Duration(timeoutMinutes)*time.Minute
}

// GetDiff returns the diff of the ticket branch vs main, excluding .task/.
func GetDiff(workspace, ticket string) (string, error) {
	return run(
		config.TaskWorktree(workspace, ticket),
		"diff", "main..HEAD", "--", ":(exclude).task",
	)
}

// GetCommitCount returns the number of commits the ticket branch is ahead of main.
func GetCommitCount(workspace, ticket string) (int, error) {
	out, err := run(config.TaskWorktree(workspace, ticket), "rev-list", "--count", "main..HEAD")
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(out)
}

// WIPCommit stages all changes and creates a pre-handoff checkpoint commit.
func WIPCommit(workspace, ticket string) error {
	wt := config.TaskWorktree(workspace, ticket)
	if _, err := run(wt, "add", "-A"); err != nil {
		return err
	}
	_, err := run(wt, "commit", "-m",
		fmt.Sprintf("wip(%s): pre-handoff checkpoint [orchestrator]", ticket))
	return err
}

// SquashMerge squash-merges the ticket branch into main.
// Returns the resulting commit hash.
func SquashMerge(workspace, ticket string) (string, error) {
	main := config.MainWorktree(workspace)
	branch := "work/" + ticket
	if _, err := run(main, "merge", "--squash", branch); err != nil {
		return "", fmt.Errorf("squash merge: %w", err)
	}
	if _, err := run(main, "commit", "-m", fmt.Sprintf("feat: complete %s", ticket)); err != nil {
		return "", fmt.Errorf("commit after squash: %w", err)
	}
	return run(main, "rev-parse", "HEAD")
}

// ensureTaskGitignored appends .task/ to the worktree's .gitignore if absent.
func ensureTaskGitignored(worktreePath string) {
	gitignore := filepath.Join(worktreePath, ".gitignore")
	entry := ".task/"

	data, err := os.ReadFile(gitignore)
	if err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			if strings.TrimSpace(line) == entry {
				return
			}
		}
	}
	f, err := os.OpenFile(gitignore, os.O_APPEND|os.O_WRONLY|os.O_CREATE, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "\n# llm-flow: task context (not part of implementation)\n%s\n", entry)
}
