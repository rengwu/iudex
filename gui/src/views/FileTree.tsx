import { useMemo, useState, type ReactNode } from "react";
import s from "./Worktrees.module.scss";

// A directory node built from the flat, gitignored-filtered path list that
// `list_tree` returns. Files sort under their folder; folders collapse.
type Dir = {
  name: string;
  path: string;
  dirs: Map<string, Dir>;
  files: { name: string; path: string }[];
};

function buildTree(paths: string[]): Dir {
  const root: Dir = { name: "", path: "", dirs: new Map(), files: [] };
  for (const p of paths) {
    const parts = p.split("/");
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      let next = cur.dirs.get(name);
      if (!next) {
        next = {
          name,
          path: parts.slice(0, i + 1).join("/"),
          dirs: new Map(),
          files: [],
        };
        cur.dirs.set(name, next);
      }
      cur = next;
    }
    cur.files.push({ name: parts[parts.length - 1], path: p });
  }
  return root;
}

// The recursive tree for the "all files" browser: folders (collapsible, folders
// first) then files, indented by depth. Fully expanded by default; a file click
// selects it. Read-only — no rename/move/delete, matching the view's invariant.
export default function FileTree({
  paths,
  selected,
  onSelect,
}: {
  paths: string[];
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const tree = useMemo(() => buildTree(paths), [paths]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (p: string) =>
    setCollapsed((c) => {
      const n = new Set(c);
      n.has(p) ? n.delete(p) : n.add(p);
      return n;
    });

  const rows: ReactNode[] = [];
  const walk = (dir: Dir, depth: number) => {
    const dirs = [...dir.dirs.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const d of dirs) {
      const isCollapsed = collapsed.has(d.path);
      rows.push(
        <div
          key={`d:${d.path}`}
          className={`${s.node} ${s.folder}`}
          style={{ paddingLeft: 10 + depth * 12 }}
          onClick={() => toggle(d.path)}
        >
          <span className={s.twisty}>{isCollapsed ? "▸" : "▾"}</span>
          <span className={s.nodeName}>{d.name}</span>
        </div>,
      );
      if (!isCollapsed) walk(d, depth + 1);
    }
    for (const f of dir.files) {
      rows.push(
        <div
          key={`f:${f.path}`}
          className={`${s.node} ${f.path === selected ? s.active : ""}`}
          style={{ paddingLeft: 10 + depth * 12 + 14 }}
          onClick={() => onSelect(f.path)}
        >
          <span className={s.nodeName}>{f.name}</span>
        </div>,
      );
    }
  };
  walk(tree, 0);

  return <div className={s.tree}>{rows}</div>;
}
