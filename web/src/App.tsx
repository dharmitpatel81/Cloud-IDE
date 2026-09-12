import { useEffect, useState } from "react";
import { api, type Project, type User } from "./api";
import { AuthForm } from "./AuthForm";
import { ProjectsPage } from "./ProjectsPage";
import { Editor } from "./Editor";

function App() {
  // undefined = still checking the session, null = signed out.
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [openProject, setOpenProject] = useState<Project | null>(null);

  useEffect(() => {
    api.me().then(setUser, () => setUser(null));
  }, []);

  if (user === undefined) {
    return (
      <div className="app">
        <p className="hint">Loading…</p>
      </div>
    );
  }

  if (user === null) {
    return (
      <div className="app">
        <h2>Cloud IDE</h2>
        <AuthForm onSignedIn={setUser} />
      </div>
    );
  }

  if (openProject) {
    return <Editor project={openProject} onClose={() => setOpenProject(null)} />;
  }

  return (
    <ProjectsPage
      user={user}
      onOpen={setOpenProject}
      onSignedOut={() => {
        setUser(null);
        setOpenProject(null);
      }}
    />
  );
}

export default App;
