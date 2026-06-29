import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { View } from "../types";

// Cross-view navigation. One current `view` plus a per-view map of pending
// "focus" requests, replacing the old proliferation of focusX states wired
// through onGoToX / onFocusHandled prop chains. A source calls `goTo(view,
// focus)`; the target view reads its focus via `usePendingFocus(view)`.
//
// A Focus is what the target should select/open: `id` is view-specific (a tmux
// session name for terminal/agents; a ticket id for tickets/review) and `tab`
// is an optional sub-target (the Agents console tab).
export type Focus = { id: string; tab?: string };

export type NavValue = {
  view: View;
  goTo: (view: View, focus?: Focus) => void;
  focus: Partial<Record<View, Focus>>;
  clearFocus: (view: View) => void;
};

export const NavContext = createContext<NavValue | null>(null);

function useNavContext(): NavValue {
  const ctx = useContext(NavContext);
  if (!ctx) {
    throw new Error("nav hooks must be used within <NavContext.Provider>");
  }
  return ctx;
}

// Built once in the app root: spread `value` into the provider; keep
// `view`/`setView` for the sidebar + keep-alive host.
export function useNavState(initial: View) {
  const [view, setView] = useState<View>(initial);
  const [focus, setFocus] = useState<Partial<Record<View, Focus>>>({});

  const goTo = useCallback((v: View, f?: Focus) => {
    if (f) setFocus((m) => ({ ...m, [v]: f }));
    setView(v);
  }, []);

  const clearFocus = useCallback((v: View) => {
    setFocus((m) => {
      if (!(v in m)) return m;
      const next = { ...m };
      delete next[v];
      return next;
    });
  }, []);

  const value = useMemo<NavValue>(
    () => ({ view, goTo, focus, clearFocus }),
    [view, goTo, focus, clearFocus],
  );
  return { view, setView, value };
}

// Navigate to a view (optionally focusing something there) + read current view.
export function useNav(): { view: View; goTo: NavValue["goTo"] } {
  const { view, goTo } = useNavContext();
  return { view, goTo };
}

// In a target view: read the focus addressed to it, exactly once. Returned for
// the render where it lands, then auto-cleared so re-navigating to the same
// target (a fresh Focus object) fires again.
export function usePendingFocus(view: View): Focus | undefined {
  const { focus, clearFocus } = useNavContext();
  const pending = focus[view];
  useEffect(() => {
    if (pending) clearFocus(view);
  }, [pending, view, clearFocus]);
  return pending;
}
