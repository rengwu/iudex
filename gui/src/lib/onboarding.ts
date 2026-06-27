import { useState, useEffect, useCallback } from "react";
import * as api from "./api";

// First-run setup state. The agent-command pool is machine-level
// (~/.iudex/config.yml) and required for any spawn, so a fresh machine needs it
// before iudex can do its job. This tracks whether it's configured and drives the
// onboarding popup. `ready` gates the read on the CLI being reachable (the read
// shells `iudex config --json`). Mirrors the other lib hooks (useWorkspace,
// useAutomation) so App just wires it up.
//
// Auto-open is state-driven, not a persisted flag: an empty pool opens the popup
// once per session (until dismissed); a successful save clears `poolEmpty`, and
// wiping the config re-triggers it on the next launch.
export function useOnboarding(ready: boolean): {
  poolEmpty: boolean;
  showOnboarding: boolean;
  openOnboarding: () => void;
  closeOnboarding: () => void;
} {
  const [poolEmpty, setPoolEmpty] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const refreshPool = useCallback(() => {
    api
      .readAgentConfig()
      .then((cfg) => setPoolEmpty(cfg.commands.length === 0))
      .catch(() => {}); // unreadable → the CLI gate handles a missing binary
  }, []);

  useEffect(() => {
    if (ready) refreshPool();
  }, [ready, refreshPool]);

  useEffect(() => {
    if (poolEmpty && !dismissed) setShowOnboarding(true);
  }, [poolEmpty, dismissed]);

  const openOnboarding = useCallback(() => setShowOnboarding(true), []);
  const closeOnboarding = useCallback(() => {
    setShowOnboarding(false);
    setDismissed(true);
    refreshPool();
  }, [refreshPool]);

  return { poolEmpty, showOnboarding, openOnboarding, closeOnboarding };
}
