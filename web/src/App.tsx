import { useCallback, useEffect, useState } from "react";
import { api, type Project, type User } from "./api";
import { AuthForm } from "./AuthForm";
import { ProjectsPage } from "./ProjectsPage";
import { Editor } from "./Editor";
import { LogoIcon } from "./icons";

function App() {
  // undefined = still checking the session, null = signed out.
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [openProject, setOpenProject] = useState<Project | null>(null);

  useEffect(() => {
    api.me().then(setUser, () => setUser(null));
  }, []);

  // Stable identity on purpose: Editor's connection effect depends on it, and
  // a new function every render would reconnect the socket every render.
  const endSession = useCallback(() => {
    setUser(null);
    setOpenProject(null);
  }, []);

  if (user === undefined) {
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
    // Keyed by project id: switching projects remounts the editor, so each
    // project gets its own Y.Doc and provider instead of reusing the last one.
    return (
      <Editor
        key={openProject.id}
        project={openProject}
        user={user}
        onClose={() => setOpenProject(null)}
        onSessionEnded={endSession}
      />
    );
  }

  return <ProjectsPage user={user} onOpen={setOpenProject} onSignedOut={endSession} />;
}

export default App;
