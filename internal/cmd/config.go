package cmd

import (
	"encoding/json"
	"fmt"
	"sort"

	"github.com/spf13/cobra"

	"iudex/internal/workspace"
)

// newConfigCmd prints the workspace configuration. With --json it emits the
// machine-readable read path the GUI binds to (the config analogue of
// `status --json`); without it, a human-readable summary. It is read-only —
// editing config.yml stays the caller's job.
func newConfigCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "config",
		Short: "Print the workspace configuration",
		Args:  cobra.NoArgs,
		RunE:  runConfig,
	}
	cmd.Flags().Bool("json", false, "emit machine-readable JSON")
	return cmd
}

// jsonConfig is the machine-readable shape emitted by `iudex config --json`. It
// is the stable contract the GUI reads; like status --json, fields may be added
// but existing ones should not change meaning. Values are post-migration: a
// legacy single agent_command appears folded into agentCommands (see
// workspace.Config.migrate), so the caller never has to know the legacy form.
type jsonConfig struct {
	MainBranch           string             `json:"mainBranch"`
	MaxActive            int                `json:"maxActive"`
	QARejectLimit        int                `json:"qaRejectLimit"`
	MergeStrategy        string             `json:"mergeStrategy"`
	MergeMessageTemplate string             `json:"mergeMessageTemplate"`
	BranchPrefix         string             `json:"branchPrefix"`
	AgentCommands        []jsonAgentCommand `json:"agentCommands"`
	AgentRoles           map[string]string  `json:"agentRoles"`
}

// jsonAgentCommand is one entry of the agent-command pool.
type jsonAgentCommand struct {
	Name    string `json:"name"`
	Command string `json:"command"`
	Default bool   `json:"default"`
}

func runConfig(cmd *cobra.Command, _ []string) error {
	asJSON, err := cmd.Flags().GetBool("json")
	if err != nil {
		return err
	}
	ctx, err := loadContext()
	if err != nil {
		return err
	}
	cfg := ctx.Config

	if asJSON {
		return runConfigJSON(cmd, cfg)
	}

	out := cmd.OutOrStdout()
	fmt.Fprintf(out, "main_branch:            %s\n", cfg.MainBranch)
	fmt.Fprintf(out, "max_active:             %d\n", cfg.MaxActive)
	fmt.Fprintf(out, "qa_reject_limit:        %d\n", cfg.QARejectLimit)
	fmt.Fprintf(out, "merge_strategy:         %s\n", cfg.MergeStrategy)
	fmt.Fprintf(out, "merge_message_template: %s\n", cfg.MergeMessageTemplate)
	fmt.Fprintf(out, "branch_prefix:          %s\n", cfg.BranchPrefix)
	fmt.Fprintln(out, "agent_commands:")
	if len(cfg.AgentCommands) == 0 {
		fmt.Fprintln(out, "  (none)")
	}
	for _, a := range cfg.AgentCommands {
		def := ""
		if a.Default {
			def = " (default)"
		}
		fmt.Fprintf(out, "  %s: %s%s\n", a.Name, a.Command, def)
	}
	fmt.Fprintln(out, "agent_roles:")
	if len(cfg.AgentRoles) == 0 {
		fmt.Fprintln(out, "  (none)")
	}
	for _, role := range sortedKeys(cfg.AgentRoles) {
		fmt.Fprintf(out, "  %s -> %s\n", role, cfg.AgentRoles[role])
	}
	return nil
}

// runConfigJSON emits the workspace configuration as JSON. Slices and maps are
// always non-nil so the caller gets [] / {} rather than null.
func runConfigJSON(cmd *cobra.Command, cfg *workspace.Config) error {
	jc := jsonConfig{
		MainBranch:           cfg.MainBranch,
		MaxActive:            cfg.MaxActive,
		QARejectLimit:        cfg.QARejectLimit,
		MergeStrategy:        cfg.MergeStrategy,
		MergeMessageTemplate: cfg.MergeMessageTemplate,
		BranchPrefix:         cfg.BranchPrefix,
		AgentCommands:        make([]jsonAgentCommand, 0, len(cfg.AgentCommands)),
		AgentRoles:           map[string]string{},
	}
	for _, a := range cfg.AgentCommands {
		jc.AgentCommands = append(jc.AgentCommands, jsonAgentCommand{
			Name:    a.Name,
			Command: a.Command,
			Default: a.Default,
		})
	}
	for k, v := range cfg.AgentRoles {
		jc.AgentRoles[k] = v
	}

	enc := json.NewEncoder(cmd.OutOrStdout())
	enc.SetIndent("", "  ")
	return enc.Encode(jc)
}

// sortedKeys returns a map's keys in sorted order, for stable human output.
func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
