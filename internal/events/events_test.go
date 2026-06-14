package events

import (
	"os"
	"path/filepath"
	"testing"
)

// tempRoot creates a workspace root with an .iudex directory so EventsFile has
// somewhere to live.
func tempRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".iudex"), 0o755); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestAppendFillsAndReadAllPreservesOrder(t *testing.T) {
	root := tempRoot(t)

	a, err := Append(root, Event{Ticket: "t1", From: "", To: "queued", Trigger: "queue"})
	if err != nil {
		t.Fatal(err)
	}
	if a.ID == "" || a.TS == "" {
		t.Errorf("Append did not fill ID/TS: %+v", a)
	}
	if _, err := Append(root, Event{Ticket: "t1", From: "queued", To: "active", Trigger: "activate"}); err != nil {
		t.Fatal(err)
	}

	evs, err := ReadAll(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != 2 {
		t.Fatalf("ReadAll returned %d events, want 2", len(evs))
	}
	if evs[0].To != "queued" || evs[1].To != "active" {
		t.Errorf("order not preserved: %q then %q", evs[0].To, evs[1].To)
	}
}

func TestReadAllMissingIsEmpty(t *testing.T) {
	evs, err := ReadAll(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != 0 {
		t.Errorf("expected no events, got %d", len(evs))
	}
}

func TestReadAllSkipsMalformedLines(t *testing.T) {
	root := tempRoot(t)
	content := `{"ticket":"t1","to":"queued"}
not json
{"ticket":"t1","to":"active"}
`
	if err := os.WriteFile(filepath.Join(root, ".iudex", "events.jsonl"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	evs, err := ReadAll(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != 2 {
		t.Fatalf("expected 2 valid events, got %d", len(evs))
	}
}
