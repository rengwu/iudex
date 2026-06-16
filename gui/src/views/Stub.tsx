// Placeholder for views whose substrate isn't wired yet. Terminal and Agents
// need the tmux session pool (step 4); Worktrees, Review, and Settings come
// after. Each names what it will become so the nav shell reads as a real map.
export default function Stub({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div className="stub">
      <h2>{title}</h2>
      <p>{blurb}</p>
      <span className="stub-tag">coming soon</span>
    </div>
  );
}
