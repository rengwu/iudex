// Package git wraps the git CLI via exec.Command. No libgit2 dependency; works
// wherever git is on PATH.
package git

import (
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

// errNotImplemented marks scaffolded operations whose logic is still pending.
var errNotImplemented = errors.New("git: not implemented")

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

// CurrentBranch returns the checked-out branch name of the repo at dir.
//
// TODO(scaffold): implement (git rev-parse --abbrev-ref HEAD).
func CurrentBranch(dir string) (string, error) {
	return "", errNotImplemented
}

// HasCommits reports whether the repo at dir has at least one commit.
//
// TODO(scaffold): implement (git rev-parse --verify HEAD).
func HasCommits(dir string) (bool, error) {
	return false, errNotImplemented
}

// InitRepo runs `git init` and creates an initial empty commit. Used by
// `iudex init` only when the directory has no repo/commits yet.
//
// TODO(scaffold): implement.
func InitRepo(dir string) error {
	return errNotImplemented
}

// IsClean reports whether the working tree at dir has no uncommitted changes.
//
// TODO(scaffold): implement (git status --porcelain).
func IsClean(dir string) (bool, error) {
	return false, errNotImplemented
}

// CreateWorktree adds a worktree at dest on a new branch off base.
//
// TODO(scaffold): implement (git worktree add -b <branch> <dest> <base>).
func CreateWorktree(repoRoot, dest, branch, base string) error {
	return errNotImplemented
}

// RemoveWorktree force-removes a worktree and deletes its branch (best effort).
//
// TODO(scaffold): implement.
func RemoveWorktree(repoRoot, dest, branch string) error {
	return errNotImplemented
}

// WIPCommit stages everything in dir and commits with message (checkpoint).
//
// TODO(scaffold): implement.
func WIPCommit(dir, message string) error {
	return errNotImplemented
}

// Diff returns the diff of the worktree's branch against base, excluding .task/.
//
// TODO(scaffold): implement (git diff <base>..HEAD -- :(exclude).task).
func Diff(worktreeDir, base string) (string, error) {
	return "", errNotImplemented
}

// Merge merges branch into the currently checked-out branch at repoRoot using
// strategy ("no-ff" | "squash") and the given message. Returns the resulting
// commit hash. On any failure it aborts the merge and returns an error.
//
// TODO(scaffold): implement.
func Merge(repoRoot, branch, strategy, message string) (commit string, err error) {
	return "", errNotImplemented
}
