package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
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
	setMaxActive(t, ws, 1)
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

func setMaxActive(t *testing.T, ws string, n int) {
	t.Helper()
	p := workspace.ConfigFile(ws)
	data, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	out := strings.Replace(string(data), "max_active: 4", "max_active: "+strconv.Itoa(n), 1)
	if out == string(data) {
		t.Fatal("could not find max_active line to replace")
	}
	if err := os.WriteFile(p, []byte(out), 0o644); err != nil {
		t.Fatal(err)
	}
}
