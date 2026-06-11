package main

import (
	"bufio"
	"embed"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"

	"llm-flow/internal/archive"
	"llm-flow/internal/config"
	"llm-flow/internal/events"
	"llm-flow/internal/git"
	"llm-flow/internal/tui"
)

//go:embed all:templates
var templateFS embed.FS

func main() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

var rootCmd = &cobra.Command{
	Use:   "llm-flow",
	Short: "AI agent orchestration for git worktrees",
}

func init() {
	rootCmd.AddCommand(
		initCmd,
		startCmd,
		newTicketCmd,
		reviewCmd,
		mergeCmd,
		rejectCmd,
		finishCmd,
		manualCmd,
		statusCmd,
		archiveListCmd,
	)
	newTicketCmd.Flags().String("deps", "", "comma-separated dependency ticket IDs")
	newTicketCmd.Flags().Int("priority", 3, "priority 1–5 (5=highest)")
	rejectCmd.Flags().String("reason", "", "rejection reason")
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

var initCmd = &cobra.Command{
	Use:   "init <workspace-dir>",
	Short: "Initialize a new llm-flow workspace",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		workspaceDir := args[0]
		workspace, err := filepath.Abs(workspaceDir)
		if err != nil {
			return err
		}
		fmt.Printf("Initializing llm-flow workspace at %s\n", workspace)

		// Create workspace dir if it doesn't exist
		if err := os.MkdirAll(workspace, 0o755); err != nil {
			return err
		}

		// Check if workspace is already a git repository
		gitDir := filepath.Join(workspace, ".git")
		_, err = os.Stat(gitDir)
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		isGitRepo := !os.IsNotExist(err)

		if !isGitRepo {
			fmt.Print("No git repository found. Initialize a new one? [Y/n] ")
			reader := bufio.NewReader(os.Stdin)
			response, readErr := reader.ReadString('\n')
			if readErr != nil && readErr != io.EOF {
				return readErr
			}
			response = strings.ToLower(strings.TrimSpace(response))
			if response != "" && response != "y" && response != "yes" {
				return fmt.Errorf("a git repository is required; aborting")
			}
			fmt.Println("  Initializing git repository…")
			gitInit := exec.Command("git", "init")
			gitInit.Dir = workspace
			gitInit.Stdout, gitInit.Stderr = os.Stdout, os.Stderr
			if err := gitInit.Run(); err != nil {
				return fmt.Errorf("git init: %w", err)
			}
			// Worktrees need at least one commit on the default branch
			gitCommit := exec.Command("git", "commit", "--allow-empty", "-m", "initial commit")
			gitCommit.Dir = workspace
			gitCommit.Stdout, gitCommit.Stderr = os.Stdout, os.Stderr
			if err := gitCommit.Run(); err != nil {
				return fmt.Errorf("git init commit: %w", err)
			}
		} else {
			fmt.Println("  Existing git repository detected.")
		}

		worktreesDir := filepath.Join(workspace, "project", "worktrees")
		if err := os.MkdirAll(worktreesDir, 0o755); err != nil {
			return err
		}

		// Clone workspace repo into project/worktrees/main
		mainDir := filepath.Join(worktreesDir, "main")
		fmt.Printf("  Cloning into project/worktrees/main …\n")
		cloneCmd := exec.Command("git", "clone", ".", mainDir)
		cloneCmd.Dir = workspace
		cloneCmd.Stdout, cloneCmd.Stderr = os.Stdout, os.Stderr
		if err := cloneCmd.Run(); err != nil {
			return fmt.Errorf("git clone: %w", err)
		}

		// Create workspace directories
		for _, d := range []string{"queue", "archive"} {
			if err := os.MkdirAll(filepath.Join(workspace, d), 0o755); err != nil {
				return err
			}
		}

		// Scaffold .llmflow/ and docs/ from embedded templates
		if err := scaffoldTemplates(workspace); err != nil {
			return fmt.Errorf("scaffold templates: %w", err)
		}

		// Create empty events.jsonl
		evFile := filepath.Join(workspace, "events.jsonl")
		if _, err := os.Stat(evFile); os.IsNotExist(err) {
			if err := os.WriteFile(evFile, nil, 0o644); err != nil {
				return err
			}
		}

		fmt.Println("\n✓ Workspace ready.")
		fmt.Printf("  Next: edit %s/.llmflow/config.yml\n", workspace)
		fmt.Printf("  Then: cd %s && llm-flow start\n", workspace)
		return nil
	},
}

// scaffoldTemplates copies embedded templates into the workspace.
// templates/dot_llmflow/ → .llmflow/, templates/docs/ → docs/
func scaffoldTemplates(workspace string) error {
	return fs.WalkDir(templateFS, "templates", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel := strings.TrimPrefix(path, "templates/")
		rel = strings.Replace(rel, "dot_llmflow", ".llmflow", 1)
		if rel == "" {
			return nil
		}
		dest := filepath.Join(workspace, rel)
		if d.IsDir() {
			return os.MkdirAll(dest, 0o755)
		}
		data, err := templateFS.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(dest, data, 0o644)
	})
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

var startCmd = &cobra.Command{
	Use:   "start",
	Short: "Start the TUI monitor and background orchestrator",
	RunE: func(cmd *cobra.Command, args []string) error {
		workspace, err := config.FindWorkspace("")
		if err != nil {
			return err
		}
		return tui.Run(workspace)
	},
}

// ---------------------------------------------------------------------------
// new-ticket
// ---------------------------------------------------------------------------

var newTicketCmd = &cobra.Command{
	Use:   "new-ticket <ticket-id> <title>",
	Short: "Create a new ticket in the queue",
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		ticketID, title := args[0], args[1]
		workspace, err := config.FindWorkspace("")
		if err != nil {
			return err
		}

		queueFile := filepath.Join(config.QueueDir(workspace), ticketID+".md")
		if _, err := os.Stat(queueFile); err == nil {
			return fmt.Errorf("%s already exists", queueFile)
		}

		deps, _ := cmd.Flags().GetString("deps")
		priority, _ := cmd.Flags().GetInt("priority")

		depSection := ""
		if deps != "" {
			var lines []string
			for _, d := range strings.Split(deps, ",") {
				if d = strings.TrimSpace(d); d != "" {
					lines = append(lines, "- "+d)
				}
			}
			if len(lines) > 0 {
				depSection = "\n## Dependencies\n" + strings.Join(lines, "\n") + "\n"
			}
		}

		content := fmt.Sprintf(`# %s: %s

_Priority: %d/5_%s

## Problem Statement

<!-- Describe what needs to be done and why. Be specific. -->

## Acceptance Criteria

- [ ] ...

## Notes

<!-- Context, links, or constraints the implementing agent should know. -->
`, ticketID, title, priority, depSection)

		if err := os.WriteFile(queueFile, []byte(content), 0o644); err != nil {
			return err
		}
		if _, err := events.Append(workspace, ticketID, "none", "queued", title); err != nil {
			return err
		}
		rel, _ := filepath.Rel(workspace, queueFile)
		fmt.Printf("✓ Created %s\n  Edit it, then the orchestrator will claim it automatically.\n", rel)
		return nil
	},
}

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------

var reviewCmd = &cobra.Command{
	Use:   "review <ticket-id>",
	Short: "Show full review info for a ticket",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		ticketID := args[0]
		workspace, err := config.FindWorkspace("")
		if err != nil {
			return err
		}

		taskDir := config.TaskDir(workspace, ticketID)
		section("Brief", readFile(filepath.Join(taskDir, "brief.md")))
		section("Implementation Log", readFile(filepath.Join(taskDir, "log.md")))

		diff, err := git.GetDiff(workspace, ticketID)
		if err != nil || diff == "" {
			section("Diff (vs main)", "(no diff found)")
		} else {
			section("Diff (vs main)", diff)
		}

		reviewPath := filepath.Join(taskDir, "review.md")
		if _, err := os.Stat(reviewPath); err == nil {
			section("QA Review", readFile(reviewPath))
		} else {
			section("QA Review", "(not yet written)")
		}

		state, _ := events.GetTicketState(workspace, ticketID)
		fmt.Printf("\nCurrent state: %s\n\n", state)
		fmt.Printf("  Approve:  llm-flow merge %s\n", ticketID)
		fmt.Printf("  Reject:   llm-flow reject %s --reason \"...\"\n", ticketID)
		fmt.Printf("  Manual:   llm-flow manual %s\n", ticketID)
		return nil
	},
}

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

var mergeCmd = &cobra.Command{
	Use:   "merge <ticket-id>",
	Short: "Approve and squash-merge a ticket to main",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		ticketID := args[0]
		workspace, err := config.FindWorkspace("")
		if err != nil {
			return err
		}

		state, err := events.GetTicketState(workspace, ticketID)
		if err != nil {
			return err
		}
		if state != "pending-human-review" && state != "human-manual" {
			return fmt.Errorf("ticket %s is '%s', not ready for merge", ticketID, state)
		}

		clean, err := git.IsClean(workspace, ticketID)
		if err != nil {
			return err
		}
		if !clean {
			fmt.Println("  Uncommitted changes found — creating WIP commit…")
			if err := git.WIPCommit(workspace, ticketID); err != nil {
				return err
			}
		}

		fmt.Printf("  Squash-merging ticket/%s → main…\n", ticketID)
		commitHash, err := git.SquashMerge(workspace, ticketID)
		if err != nil {
			return err
		}

		fmt.Println("  Archiving .task/ and diff…")
		archiveDir, err := archive.Archive(workspace, ticketID, "done", commitHash, "")
		if err != nil {
			return err
		}

		fmt.Println("  Removing worktree…")
		git.RemoveWorktree(workspace, ticketID)

		events.Append(workspace, ticketID, state, "done", "merge commit: "+commitHash)

		relArchive, _ := filepath.Rel(workspace, archiveDir)
		fmt.Printf("✓ %s merged and archived.\n  Commit:  %s\n  Archive: %s\n",
			ticketID, commitHash[:12], relArchive)
		return nil
	},
}

// ---------------------------------------------------------------------------
// reject
// ---------------------------------------------------------------------------

var rejectCmd = &cobra.Command{
	Use:   "reject <ticket-id>",
	Short: "Reject a ticket and reset it to the queue",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		ticketID := args[0]
		reason, _ := cmd.Flags().GetString("reason")
		workspace, err := config.FindWorkspace("")
		if err != nil {
			return err
		}

		state, _ := events.GetTicketState(workspace, ticketID)

		fmt.Println("  Archiving rejected state…")
		archiveDir, err := archive.Archive(workspace, ticketID, "rejected", "", reason)
		if err != nil {
			return err
		}

		// Return brief to queue
		briefSrc := filepath.Join(config.TaskDir(workspace, ticketID), "brief.md")
		queueDest := filepath.Join(config.QueueDir(workspace), ticketID+".md")
		if _, err := os.Stat(briefSrc); err == nil {
			if _, err := os.Stat(queueDest); os.IsNotExist(err) {
				if data, err := os.ReadFile(briefSrc); err == nil {
					os.WriteFile(queueDest, data, 0o644)
				}
			}
		}

		git.RemoveWorktree(workspace, ticketID)
		events.Append(workspace, ticketID, orDefault(state, "unknown"), "rejected", reason)

		relArchive, _ := filepath.Rel(workspace, archiveDir)
		fmt.Printf("✓ %s rejected.\n  Archive: %s\n  Ticket reset to queue.\n",
			ticketID, relArchive)
		return nil
	},
}

// ---------------------------------------------------------------------------
// finish
// ---------------------------------------------------------------------------

var finishCmd = &cobra.Command{
	Use:   "finish <ticket-id>",
	Short: "Signal manual work is done — hands off to QA agent",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		ticketID := args[0]
		workspace, err := config.FindWorkspace("")
		if err != nil {
			return err
		}

		state, _ := events.GetTicketState(workspace, ticketID)
		clean, err := git.IsClean(workspace, ticketID)
		if err != nil {
			return err
		}
		if !clean {
			fmt.Println("  Uncommitted changes — committing…")
			if err := git.WIPCommit(workspace, ticketID); err != nil {
				return err
			}
		}

		events.Append(workspace, ticketID, orDefault(state, "human-manual"), "pending-review", "")
		fmt.Printf("✓ %s handed off to QA. State: pending-review\n", ticketID)
		return nil
	},
}

// ---------------------------------------------------------------------------
// manual
// ---------------------------------------------------------------------------

var manualCmd = &cobra.Command{
	Use:   "manual <ticket-id>",
	Short: "Take over a ticket for manual work",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		ticketID := args[0]
		workspace, err := config.FindWorkspace("")
		if err != nil {
			return err
		}

		state, _ := events.GetTicketState(workspace, ticketID)
		events.Append(workspace, ticketID, orDefault(state, "unknown"), "human-manual", "")

		wt := config.TaskWorktree(workspace, ticketID)
		rel, _ := filepath.Rel(workspace, wt)
		fmt.Printf("→ Manual session started for %s\n  cd %s\n  Done: llm-flow finish %s\n  Abort: llm-flow reject %s\n",
			ticketID, rel, ticketID, ticketID)
		return nil
	},
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Print a status overview (no TUI)",
	RunE: func(cmd *cobra.Command, args []string) error {
		workspace, err := config.FindWorkspace("")
		if err != nil {
			return err
		}

		tickets, err := events.GetAllTickets(workspace)
		if err != nil {
			return err
		}
		queue, _ := filepath.Glob(filepath.Join(config.QueueDir(workspace), "task-*.md"))

		w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
		fmt.Fprintln(w, "TICKET\tSTATE")
		fmt.Fprintln(w, "------\t-----")
		for _, f := range queue {
			name := strings.TrimSuffix(filepath.Base(f), ".md")
			fmt.Fprintf(w, "%s\t%s\n", name, "queued (unclaimed)")
		}
		for ticket, state := range tickets {
			fmt.Fprintf(w, "%s\t%s\n", ticket, state)
		}
		return w.Flush()
	},
}

// ---------------------------------------------------------------------------
// archive-list
// ---------------------------------------------------------------------------

var archiveListCmd = &cobra.Command{
	Use:   "archive-list",
	Short: "List all archived tickets",
	RunE: func(cmd *cobra.Command, args []string) error {
		workspace, err := config.FindWorkspace("")
		if err != nil {
			return err
		}

		archiveDir := config.ArchiveDir(workspace)
		entries, err := os.ReadDir(archiveDir)
		if err != nil {
			if os.IsNotExist(err) {
				fmt.Println("No archived tickets yet.")
				return nil
			}
			return err
		}

		w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
		fmt.Fprintln(w, "ARCHIVE\tDIFF\tREVIEW")
		fmt.Fprintln(w, "-------\t----\t------")
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			d := filepath.Join(archiveDir, entry.Name())
			hasDiff, hasReview := "—", "—"
			if _, err := os.Stat(filepath.Join(d, "diff.patch")); err == nil {
				hasDiff = "✓"
			}
			if _, err := os.Stat(filepath.Join(d, "review.md")); err == nil {
				hasReview = "✓"
			}
			fmt.Fprintf(w, "%s\t%s\t%s\n", entry.Name(), hasDiff, hasReview)
		}
		return w.Flush()
	},
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func readFile(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return "(not found)"
	}
	return string(data)
}

func section(title, content string) {
	fmt.Printf("\n━━━ %s ━━━\n%s\n", title, content)
}

func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}
