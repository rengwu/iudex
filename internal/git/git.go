// Package git wraps the git CLI via exec.Command. No libgit2 dependency; works
// wherever git is on PATH.
package git

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// run executes a git command in dir and returns trimmed stdout.
func run(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return "", fmt.Errorf("git %s: %s", strings.Join(args, " "), strings.TrimSpace(string(exitErr.Stderr)))
		}
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// IsRepo reports whether dir is inside a git work tree.
func IsRepo(dir string) bool {
	out, err := run(dir, "rev-parse", "--is-inside-work-tree")
	return err == nil && out == "true"
}

// Init runs `git init` in dir.
func Init(dir string) error {
	_, err := run(dir, "init")
	return err
}

// CurrentBranch returns the checked-out branch name, including an unborn branch
// (a fresh repo with no commits yet). It fails on a detached HEAD.
func CurrentBranch(dir string) (string, error) {
	return run(dir, "symbolic-ref", "--short", "HEAD")
}

// HasCommits reports whether HEAD resolves to a commit. A repo with no commits
// yet returns false, nil.
func HasCommits(dir string) (bool, error) {
	if _, err := run(dir, "rev-parse", "--verify", "HEAD"); err != nil {
		return false, nil
	}
	return true, nil
}

// CommitAll stages everything and commits with message. If there is nothing to
// stage (e.g. a blank directory), it falls back to an empty commit so that
// worktrees later have a base commit to branch from.
func CommitAll(dir, message string) error {
	if _, err := run(dir, "add", "-A"); err != nil {
		return err
	}
	if _, err := run(dir, "commit", "-m", message); err != nil {
		if _, err2 := run(dir, "commit", "--allow-empty", "-m", message); err2 != nil {
			return err2
		}
	}
	return nil
}

// IsClean reports whether the working tree at dir has no uncommitted changes
// (ignored paths such as .task/ do not count).
func IsClean(dir string) (bool, error) {
	out, err := run(dir, "status", "--porcelain")
	if err != nil {
		return false, err
	}
	return out == "", nil
}

// CreateWorktree adds a worktree at dest on a new branch off base, run from the
// main worktree at repoRoot.
func CreateWorktree(repoRoot, dest, branch, base string) error {
	if _, err := run(repoRoot, "worktree", "add", "-b", branch, dest, base); err != nil {
		return fmt.Errorf("create worktree: %w", err)
	}
	return nil
}

// EnsureExclude appends pattern to the repository's shared exclude file
// (info/exclude in the common git dir) if not already present. The pattern is
// then ignored in every worktree without touching any tracked .gitignore.
func EnsureExclude(repoRoot, pattern string) error {
	common, err := run(repoRoot, "rev-parse", "--git-common-dir")
	if err != nil {
		return err
	}
	if !filepath.IsAbs(common) {
		common = filepath.Join(repoRoot, common)
	}
	infoDir := filepath.Join(common, "info")
	if err := os.MkdirAll(infoDir, 0o755); err != nil {
		return err
	}
	exclude := filepath.Join(infoDir, "exclude")
	data, err := os.ReadFile(exclude)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) == pattern {
			return nil
		}
	}
	f, err := os.OpenFile(exclude, os.O_APPEND|os.O_WRONLY|os.O_CREATE, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	prefix := ""
	if len(data) > 0 && !strings.HasSuffix(string(data), "\n") {
		prefix = "\n"
	}
	_, err = fmt.Fprintf(f, "%s%s\n", prefix, pattern)
	return err
}

// RemoveWorktree force-removes a worktree and deletes its branch.
func RemoveWorktree(repoRoot, dest, branch string) error {
	if _, err := run(repoRoot, "worktree", "remove", "--force", dest); err != nil {
		return err
	}
	if _, err := run(repoRoot, "branch", "-D", branch); err != nil {
		return err
	}
	return nil
}

// WIPCommit stages everything in dir and commits with message (a checkpoint).
// Ignored paths (.task/) are not staged.
func WIPCommit(dir, message string) error {
	if _, err := run(dir, "add", "-A"); err != nil {
		return err
	}
	_, err := run(dir, "commit", "-m", message)
	return err
}

// Diff returns the changes the worktree's branch introduced relative to base
// (three-dot, so changes that landed on base afterwards aren't shown). .task/ is
// untracked and never appears.
func Diff(worktreeDir, base string) (string, error) {
	return run(worktreeDir, "diff", base+"...HEAD")
}

// Merge merges branch into the branch currently checked out at repoRoot using
// strategy ("squash" or, by default, "no-ff") and message, returning the new
// commit hash. On any failure it restores the working tree (the caller must
// ensure it was clean first) and returns an error.
func Merge(repoRoot, branch, strategy, message string) (string, error) {
	var mergeErr error
	switch strategy {
	case "squash":
		if _, err := run(repoRoot, "merge", "--squash", branch); err != nil {
			mergeErr = err
		} else if _, err := run(repoRoot, "commit", "-m", message); err != nil {
			mergeErr = err
		}
	default: // "no-ff"
		_, mergeErr = run(repoRoot, "merge", "--no-ff", "-m", message, branch)
	}
	if mergeErr != nil {
		run(repoRoot, "merge", "--abort")        // best effort
		run(repoRoot, "reset", "--hard", "HEAD") // ensure a clean restore
		return "", fmt.Errorf("merge %s: %w", branch, mergeErr)
	}
	return run(repoRoot, "rev-parse", "HEAD")
}
