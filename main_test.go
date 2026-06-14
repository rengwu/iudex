package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"iudex/internal/events"
	"iudex/internal/workspace"
)

var (
	iudexBin      string
	gitConfigPath string
)

// TestMain builds the binary once and writes a hermetic git config so the CLI
// tests don't depend on the machine's global git settings.
func TestMain(m *testing.M) {
	tmp, err := os.MkdirTemp("", "iudex-cli-test")
	if err != nil {
		panic(err)
	}
	defer os.RemoveAll(tmp)

	iudexBin = filepath.Join(tmp, "iudex")
	build := exec.Command("go", "build", "-o", iudexBin, ".")
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		panic("build iudex: " + err.Error())
	}

	gitConfigPath = filepath.Join(tmp, "gitconfig")
	cfg := "[init]\n\tdefaultBranch = main\n[user]\n\tname = iudex test\n\temail = test@iudex.test\n"
	if err := os.WriteFile(gitConfigPath, []byte(cfg), 0o644); err != nil {
		panic(err)
	}

	os.Exit(m.Run())
}

// iudex runs the built binary in workdir with a hermetic git environment.
func iudex(t *testing.T, workdir string, args ...string) (string, error) {
	t.Helper()
	cmd := exec.Command(iudexBin, args...)
	cmd.Dir = workdir
	cmd.Env = append(os.Environ(),
		"GIT_CONFIG_GLOBAL="+gitConfigPath,
		"GIT_CONFIG_SYSTEM="+os.DevNull,
		"GIT_AUTHOR_NAME=iudex test", "GIT_AUTHOR_EMAIL=test@iudex.test",
		"GIT_COMMITTER_NAME=iudex test", "GIT_COMMITTER_EMAIL=test@iudex.test",
	)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func mustRun(t *testing.T, workdir string, args ...string) string {
	t.Helper()
	out, err := iudex(t, workdir, args...)
	if err != nil {
		t.Fatalf("iudex %v in %s failed: %v\n%s", args, workdir, err, out)
	}
	return out
}

func mustFail(t *testing.T, workdir string, args ...string) string {
	t.Helper()
	out, err := iudex(t, workdir, args...)
	if err == nil {
		t.Fatalf("iudex %v expected failure, got success:\n%s", args, out)
	}
	return out
}

func newWorkspace(t *testing.T) string {
	t.Helper()
	ws := t.TempDir()
	mustRun(t, ws, "init")
	return ws
}

func author(t *testing.T, ws, id string) {
	t.Helper()
	p := filepath.Join(ws, ".iudex", "queue", id+".md")
	if err := os.WriteFile(p, []byte("# "+id+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// lastState reads the event log directly and returns the most recent state of a
// ticket, independent of the ticket package's derivation.
func lastState(t *testing.T, ws, id string) string {
	t.Helper()
	evs, err := events.ReadAll(ws)
	if err != nil {
		t.Fatal(err)
	}
	state := ""
	for _, e := range evs {
		if e.Ticket == id {
			state = e.To
		}
	}
	return state
}

func wantState(t *testing.T, ws, id, want string) {
	t.Helper()
	if got := lastState(t, ws, id); got != want {
		t.Fatalf("state of %s = %q, want %q", id, got, want)
	}
}

func TestCLILifecycleToPendingQA(t *testing.T) {
	ws := newWorkspace(t)
	author(t, ws, "t1")

	mustRun(t, ws, "queue", "t1")
	wantState(t, ws, "t1", "queued")

	mustRun(t, ws, "activate", "t1")
	wantState(t, ws, "t1", "active")

	if _, err := os.Stat(filepath.Join(ws, ".iudex", "queue", "t1.md")); !os.IsNotExist(err) {
		t.Errorf("queue file should be moved out after activate")
	}
	for _, f := range []string{"brief.md", "log.md"} {
		if _, err := os.Stat(filepath.Join(ws, ".iudex", "worktrees", "t1", ".task", f)); err != nil {
			t.Errorf(".task/%s missing after activate: %v", f, err)
		}
	}

	// finish inferred from the worktree cwd, no explicit id.
	wt := filepath.Join(ws, ".iudex", "worktrees", "t1")
	mustRun(t, wt, "finish")
	wantState(t, ws, "t1", "pending-qa")
}

func TestCLIActivateBlockedByDep(t *testing.T) {
	ws := newWorkspace(t)
	author(t, ws, "t1")
	author(t, ws, "t2")
	mustRun(t, ws, "queue", "t1")
	mustRun(t, ws, "queue", "t2", "--deps", "t1")

	mustFail(t, ws, "activate", "t2") // t1 still queued
	wantState(t, ws, "t2", "queued")

	mustRun(t, ws, "activate", "t1")
	mustFail(t, ws, "activate", "t2") // t1 active, not done
	wantState(t, ws, "t2", "queued")
}

func TestCLIMaxActiveCap(t *testing.T) {
	ws := newWorkspace(t)
	setConfigInt(t, ws, "max_active", 1)
	author(t, ws, "t1")
	author(t, ws, "t2")
	mustRun(t, ws, "queue", "t1")
	mustRun(t, ws, "queue", "t2")

	mustRun(t, ws, "activate", "t1")
	out := mustFail(t, ws, "activate", "t2")
	if !strings.Contains(out, "max_active") {
		t.Errorf("expected max_active error, got:\n%s", out)
	}
	wantState(t, ws, "t2", "queued")
}

func TestCLIQueueValidation(t *testing.T) {
	ws := newWorkspace(t)

	mustFail(t, ws, "queue", "t1") // no brief authored yet
	author(t, ws, "t1")
	mustRun(t, ws, "queue", "t1")
	mustFail(t, ws, "queue", "t1")       // reuse
	mustFail(t, ws, "queue", "ticket-1") // bad id format
	author(t, ws, "t2")
	mustFail(t, ws, "queue", "t2", "--deps", "t99") // unregistered dep
	wantState(t, ws, "t2", "")                      // never registered
}

// toPendingQA drives a fresh ticket from authoring through to pending-qa.
func toPendingQA(t *testing.T, ws, id string) {
	t.Helper()
	author(t, ws, id)
	mustRun(t, ws, "queue", id)
	mustRun(t, ws, "activate", id)
	mustRun(t, filepath.Join(ws, ".iudex", "worktrees", id), "finish")
	wantState(t, ws, id, "pending-qa")
}

func TestCLIQAApprove(t *testing.T) {
	ws := newWorkspace(t)
	toPendingQA(t, ws, "t1")
	mustRun(t, ws, "qa", "approve", "t1")
	wantState(t, ws, "t1", "pending-human-qa")
}

func TestCLIQARejectBackToActive(t *testing.T) {
	ws := newWorkspace(t)
	toPendingQA(t, ws, "t1")
	// reject inferred from the worktree cwd, no explicit id.
	mustRun(t, filepath.Join(ws, ".iudex", "worktrees", "t1"), "qa", "reject")
	wantState(t, ws, "t1", "active")
}

func TestCLIQARejectToFailedAtLimit(t *testing.T) {
	ws := newWorkspace(t)
	setConfigInt(t, ws, "qa_reject_limit", 1)
	toPendingQA(t, ws, "t1")
	mustRun(t, ws, "qa", "reject", "t1")
	wantState(t, ws, "t1", "failed")
}

// toPendingHumanQA drives a fresh ticket all the way to pending-human-qa, with
// a committed change in its worktree so there is something to merge.
func toPendingHumanQA(t *testing.T, ws, id string) {
	t.Helper()
	author(t, ws, id)
	mustRun(t, ws, "queue", id)
	mustRun(t, ws, "activate", id)
	wt := filepath.Join(ws, ".iudex", "worktrees", id)
	if err := os.WriteFile(filepath.Join(wt, "app_"+id+".txt"), []byte("work for "+id+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustRun(t, wt, "finish") // auto-commits the change
	mustRun(t, ws, "qa", "approve", id)
	wantState(t, ws, id, "pending-human-qa")
}

func TestCLIHumanQAApproveToDone(t *testing.T) {
	ws := newWorkspace(t)
	toPendingHumanQA(t, ws, "t1")
	mustRun(t, ws, "human-qa", "approve", "t1")
	wantState(t, ws, "t1", "done")

	if _, err := os.Stat(filepath.Join(ws, ".iudex", "worktrees", "t1")); !os.IsNotExist(err) {
		t.Error("worktree should be removed after approve")
	}
	for _, f := range []string{"brief.md", "diff.patch", "meta.json"} {
		if _, err := os.Stat(filepath.Join(ws, ".iudex", "archive", "t1", f)); err != nil {
			t.Errorf("archive/%s missing: %v", f, err)
		}
	}
	if _, err := os.Stat(filepath.Join(ws, "app_t1.txt")); err != nil {
		t.Error("merged change should be present on main at the repo root")
	}
}

func TestCLIHumanQARejectBackToActive(t *testing.T) {
	ws := newWorkspace(t)
	toPendingHumanQA(t, ws, "t1")
	mustRun(t, ws, "human-qa", "reject", "t1", "--reason", "needs error handling")
	wantState(t, ws, "t1", "active")

	data, err := os.ReadFile(filepath.Join(ws, ".iudex", "worktrees", "t1", ".task", "review.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "needs error handling") {
		t.Errorf("review.md missing human feedback:\n%s", data)
	}
}

func TestCLIRetryFromFailed(t *testing.T) {
	ws := newWorkspace(t)
	setConfigInt(t, ws, "qa_reject_limit", 1)
	toPendingQA(t, ws, "t1")
	mustRun(t, ws, "qa", "reject", "t1")
	wantState(t, ws, "t1", "failed")
	mustRun(t, ws, "retry", "t1")
	wantState(t, ws, "t1", "active")
}

func TestCLIApproveRefusesDirtyRoot(t *testing.T) {
	ws := newWorkspace(t)
	toPendingHumanQA(t, ws, "t1")
	if err := os.WriteFile(filepath.Join(ws, "dirty.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustFail(t, ws, "human-qa", "approve", "t1")
	wantState(t, ws, "t1", "pending-human-qa")
}

func TestCLIApproveRefusesOffMain(t *testing.T) {
	ws := newWorkspace(t)
	toPendingHumanQA(t, ws, "t1")
	gitC(t, ws, "checkout", "-b", "feature")
	mustFail(t, ws, "human-qa", "approve", "t1")
	wantState(t, ws, "t1", "pending-human-qa")
}

func TestCLIRemoveQueued(t *testing.T) {
	ws := newWorkspace(t)
	author(t, ws, "t1")
	mustRun(t, ws, "queue", "t1")
	mustRun(t, ws, "remove", "t1")
	wantState(t, ws, "t1", "removed")

	if _, err := os.Stat(filepath.Join(ws, ".iudex", "queue", "t1.md")); !os.IsNotExist(err) {
		t.Error("queue file should be cleared on remove")
	}
	if _, err := os.Stat(filepath.Join(ws, ".iudex", "archive", "t1", "brief.md")); err != nil {
		t.Error("queued brief should be preserved in the archive")
	}
}

func TestCLIRemoveActive(t *testing.T) {
	ws := newWorkspace(t)
	author(t, ws, "t1")
	mustRun(t, ws, "queue", "t1")
	mustRun(t, ws, "activate", "t1")
	mustRun(t, ws, "remove", "t1")
	wantState(t, ws, "t1", "removed")

	if _, err := os.Stat(filepath.Join(ws, ".iudex", "worktrees", "t1")); !os.IsNotExist(err) {
		t.Error("worktree should be removed")
	}
	if _, err := os.Stat(filepath.Join(ws, ".iudex", "archive", "t1", "meta.json")); err != nil {
		t.Error("archive should exist after remove")
	}
}

func TestCLIRemoveRefusesTerminal(t *testing.T) {
	ws := newWorkspace(t)
	toPendingHumanQA(t, ws, "t1")
	mustRun(t, ws, "human-qa", "approve", "t1")
	wantState(t, ws, "t1", "done")
	mustFail(t, ws, "remove", "t1")
}

// gitC runs git in dir with the hermetic test environment.
func gitC(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(),
		"GIT_CONFIG_GLOBAL="+gitConfigPath,
		"GIT_CONFIG_SYSTEM="+os.DevNull,
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

// setConfigInt rewrites a `key: <int>` line in the workspace config.
func setConfigInt(t *testing.T, ws, key string, val int) {
	t.Helper()
	p := workspace.ConfigFile(ws)
	data, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(string(data), "\n")
	found := false
	for i, ln := range lines {
		if strings.HasPrefix(ln, key+":") {
			lines[i] = fmt.Sprintf("%s: %d", key, val)
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("config key %q not found", key)
	}
	if err := os.WriteFile(p, []byte(strings.Join(lines, "\n")), 0o644); err != nil {
		t.Fatal(err)
	}
}
