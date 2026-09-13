import { useEffect, useMemo, useState } from "react";
import { api, type Project, type User } from "./api";
import { ClearIcon, EditIcon, FolderIcon, LogoIcon, PlusIcon, SignOutIcon } from "./icons";

export function ProjectsPage({
  user,
  onOpen,
  onSignedOut,
}: {
  user: User;
  onOpen: (project: Project) => void;
  onSignedOut: () => void;
}) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listProjects().then(setProjects, (err: unknown) =>
      setError(err instanceof Error ? err.message : "Could not load projects."),
    );
  }, []);

  const newestFirst = useMemo(
    () => projects && [...projects].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [projects],
  );

  async function createProject(event: { preventDefault(): void }) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError("");
    try {
      const project = await api.createProject(name.trim());
      setName("");
      setProjects((prev) => (prev ? [...prev, project] : [project]));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create project.");
    } finally {
      setBusy(false);
    }
  }

  async function renameProject(project: Project) {
    const name = window.prompt("Project name", project.name)?.trim();
    if (!name || name === project.name) return;
    setError("");
    try {
      const updated = await api.renameProject(project.id, name);
      setProjects((prev) => prev?.map((p) => (p.id === updated.id ? updated : p)) ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rename project.");
    }
  }

  async function deleteProject(project: Project) {
    if (!window.confirm(`Delete "${project.name}"? Its files and terminal are gone for good.`)) return;
    setError("");
    try {
      await api.deleteProject(project.id);
      setProjects((prev) => prev?.filter((p) => p.id !== project.id) ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete project.");
    }
  }

  async function signOut() {
    // Don't swallow a failed logout. Showing the login form while the
    // session is still valid server-side is worse than showing an error —
    // it looks signed out, and a refresh proves it isn't.
    try {
      await api.logout();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign out.");
      return;
    }
    onSignedOut();
  }

  return (
    <div className="launcher">
      <header className="launcher-bar">
        <span className="brand">
          <LogoIcon size={18} /> Cloud IDE
        </span>
        <div className="launcher-user">
          <span className="avatar" aria-hidden="true">
            {user.email.charAt(0).toUpperCase()}
          </span>
          <span>{user.email}</span>
          <button type="button" className="btn btn-ghost" onClick={signOut}>
            <SignOutIcon size={18} /> Sign out
          </button>
        </div>
      </header>

      <main className="launcher-main">
        <h1>Projects</h1>
        <p className="muted launcher-sub">
          Each project is a set of files and folders, synced live across every tab you open it in.
        </p>

        <form className="new-project-form" onSubmit={createProject}>
          <div className="new-project">
            <input
              className="text-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="New project name"
              aria-label="New project name"
              maxLength={100}
            />
            <button className="btn btn-primary" type="submit" disabled={busy || !name.trim()}>
              <PlusIcon size={14} /> Create
            </button>
          </div>
        </form>

        {error && <div className="error-banner">{error}</div>}

        <h2 className="section-label">All projects</h2>
        {newestFirst === null ? (
          <p className="muted">Loading projects…</p>
        ) : newestFirst.length === 0 ? (
          <div className="empty-state">No projects yet. Create your first one above.</div>
        ) : (
          <div className="project-grid">
            {newestFirst.map((project) => (
              <div key={project.id} className="project-card">
                <button type="button" className="project-card-open" onClick={() => onOpen(project)}>
                  <FolderIcon size={26} />
                  <span className="project-card-name">{project.name}</span>
                  <span className="project-card-meta">
                    Created {new Date(project.createdAt).toLocaleDateString()}
                  </span>
                </button>
                <div className="project-card-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    title={`Rename ${project.name}`}
                    aria-label={`Rename ${project.name}`}
                    onClick={() => renameProject(project)}
                  >
                    <EditIcon size={18} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn project-card-delete"
                    title={`Delete ${project.name}`}
                    aria-label={`Delete ${project.name}`}
                    onClick={() => deleteProject(project)}
                  >
                    <ClearIcon size={18} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
