import { useEffect, useState } from "react";
import { api, type Project, type User } from "./api";

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

  async function refresh() {
    try {
      setProjects(await api.listProjects());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load projects.");
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function createProject(event: React.FormEvent) {
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

  async function signOut() {
    await api.logout().catch(() => {});
    onSignedOut();
  }

  return (
    <div className="app">
      <div className="topbar">
        <h2>Your projects</h2>
        <div className="topbar-right">
          <span className="hint">{user.email}</span>
          <button type="button" className="link-btn" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>

      <form className="card new-project-form" onSubmit={createProject}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New project name"
          maxLength={100}
        />
        <button className="run-btn" type="submit" disabled={busy || !name.trim()}>
          Create
        </button>
      </form>

      {error && <div className="error-banner">{error}</div>}

      {projects === null ? (
        <p className="hint">Loading projects…</p>
      ) : projects.length === 0 ? (
        <p className="hint">No projects yet. Create one above.</p>
      ) : (
        <ul className="project-list">
          {projects.map((project) => (
            <li key={project.id}>
              <button type="button" className="project-item" onClick={() => onOpen(project)}>
                {project.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
