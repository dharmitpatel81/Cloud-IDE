import { useState } from "react";
import { api, type User } from "./api";
import { FileCodeIcon, LogoIcon, ProjectsIcon, TerminalIcon } from "./icons";

const FEATURES: [typeof LogoIcon, string][] = [
  [FileCodeIcon, "Write and run Python and Node in your browser"],
  [ProjectsIcon, "Collaborate in real time — one document, every tab"],
  [TerminalIcon, "A real terminal in an isolated sandbox"],
];

export function AuthForm({ onSignedIn }: { onSignedIn: (user: User) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const isLogin = mode === "login";

  async function submit(event: { preventDefault(): void }) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const user = isLogin ? await api.login(email, password) : await api.register(email, password);
      onSignedIn(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <section className="auth-hero">
        <div className="brand brand-lg">
          <LogoIcon /> Cloud IDE
        </div>
        <h1>Build better software</h1>
        <ul className="auth-features">
          {FEATURES.map(([Icon, text]) => (
            <li key={text}>
              <Icon size={28} />
              <span>{text}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="auth-side">
        <form className="auth-form" onSubmit={submit}>
          <h2>{isLogin ? "Log in to Cloud IDE" : "Create your account"}</h2>

          <input
            className="text-input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            aria-label="Email"
            autoComplete="email"
            required
          />
          <input
            className="text-input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            aria-label="Password"
            autoComplete={isLogin ? "current-password" : "new-password"}
            minLength={8}
            required
          />

          {error && <div className="error-banner">{error}</div>}

          <button className="btn btn-sky btn-block" type="submit" disabled={busy}>
            {busy ? "Working…" : isLogin ? "Log In" : "Sign Up"}
          </button>

          <p className="auth-switch">
            {isLogin ? "Don't have an account? " : "Already have an account? "}
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setMode(isLogin ? "register" : "login");
                setError("");
              }}
            >
              {isLogin ? "Sign up" : "Log in"}
            </button>
          </p>

          <p className="auth-hint">
            Use a throwaway password. Passwords are stored as scrypt hashes, but this is a
            learning build that has never been security reviewed.
          </p>
        </form>
      </section>
    </div>
  );
}
