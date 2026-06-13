package queue

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

// ParseDependencies reads a ticket markdown file and returns the list of
// dependency ticket IDs declared under the "## Dependencies" heading.
// Returns nil, nil if the section is not present. Returns an error if the
// file does not exist or cannot be read.
func ParseDependencies(ticketFile string) ([]string, error) {
	f, err := os.Open(ticketFile)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("ticket file not found: %s", ticketFile)
		}
		return nil, err
	}
	defer f.Close()

	var deps []string
	inDeps := false
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		trimmed := strings.TrimSpace(line)
		if trimmed == "## Dependencies" {
			inDeps = true
			continue
		}
		if inDeps {
			if strings.HasPrefix(trimmed, "## ") {
				break
			}
			if strings.HasPrefix(trimmed, "- ") {
				deps = append(deps, strings.TrimPrefix(trimmed, "- "))
			}
		}
	}
	return deps, scanner.Err()
}

// DepsReady returns true if every dependency declared in ticketFile is in
// "done" state according to allStates. A dep absent from allStates is treated
// as not-done. Returns true when there are no dependencies.
func DepsReady(ticketFile string, allStates map[string]string) (bool, error) {
	deps, err := ParseDependencies(ticketFile)
	if err != nil {
		return false, err
	}
	for _, dep := range deps {
		if allStates[dep] != "done" {
			return false, nil
		}
	}
	return true, nil
}

// BlockingDeps returns dep IDs from ticketFile that are not yet "done".
// Returns nil if all deps are satisfied, the file has no deps section, or the
// file cannot be read.
func BlockingDeps(ticketFile string, allStates map[string]string) []string {
	deps, err := ParseDependencies(ticketFile)
	if err != nil || len(deps) == 0 {
		return nil
	}
	var blocking []string
	for _, dep := range deps {
		if allStates[dep] != "done" {
			blocking = append(blocking, dep)
		}
	}
	return blocking
}
