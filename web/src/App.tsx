import { useCallback, useEffect, useState } from "react";
import { api, type Project, type User } from "./api";
import { AuthForm } from "./AuthForm";
import { ProjectsPage } from "./ProjectsPage";
import { Workspace } from "./Workspace";
import { LogoIcon } from "./icons";

const PROJECT_PATH = /^\/project\/([0-9a-f-]{36})\/?$/i;

/** The project id in the address bar, if any. It's only a request: the
 *  server still decides whether this user may open that project. */
function projectIdInUrl(): string | null {
  return PROJECT_PATH.exec(location.pathname)?.[1] ?? null;
}

function App() {
  // undefined = still checking the session, null = signed out.
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [openProject, setOpenProject] = useState<Project | null>(null);
  // True while the project named in the URL is being fetched, so a refresh
  // shows a splash instead of flashing the project list first.
  const [restoring, setRestoring] = useState(() => projectIdInUrl() !== null);

  useEffect(() => {
    api.me().then(setUser, () => setUser(null));
  }, []);

  // The URL decides which project is open, so a refresh, a bookmark and the
  // back/forward buttons all land in the same place. Re-runs on sign-in, so a
  // session that expired mid-project returns you to that project.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const followUrl = () => {
      const id = projectIdInUrl();
      if (!id) {
        setOpenProject(null);
        setRestoring(false);
        return;
      }
      setRestoring(true);
      api
        .getProject(id)
        .then(
          (project) => {
            if (!cancelled) setOpenProject(project);
          },
          () => {
            // Not yours, deleted, or never existed: the server says 404 for
            // all three on purpose, and all three mean "back to the list".
            if (cancelled) return;
            history.replaceState(null, "", "/");
            setOpenProject(null);
          },
        )
        .finally(() => {
          if (!cancelled) setRestoring(false);
        });
    };
    followUrl();
    window.addEventListener("popstate", followUrl);
    return () => {
      cancelled = true;
      window.removeEventListener("popstate", followUrl);
    };
  }, [user]);

  const openProjectPage = useCallback((project: Project) => {
    history.pushState(null, "", `/project/${project.id}`);
    setOpenProject(project);
  }, []);

  // Stable identity on purpose, like endSession: Workspace's connection
  // effect depends on both, and a new function every render would reconnect
  // the socket every render.
  const closeProject = useCallback(() => {
    history.pushState(null, "", "/");
    setOpenProject(null);
  }, []);

  // Leaves the URL alone, so signing back in returns to the same project.
  const endSession = useCallback(() => {
    setUser(null);
    setOpenProject(null);
  }, []);

  if (user === undefined || (user && restoring)) {
    return (
      <div className="splash">
        <LogoIcon size={22} /> Loading…
      </div>
    );
  }

  if (user === null) {
    return <AuthForm onSignedIn={setUser} />;
  }

  if (openProject) {
    // Keyed by project id: switching projects remounts the workspace, so each
    // project gets its own Y.Doc and provider instead of reusing the last one.
    return (
      <Workspace
        key={openProject.id}
        project={openProject}
        user={user}
        onClose={closeProject}
        onSessionEnded={endSession}
      />
    );
  }

  return <ProjectsPage user={user} onOpen={openProjectPage} onSignedOut={endSession} />;
}

export default App;
