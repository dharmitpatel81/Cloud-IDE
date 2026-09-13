import { useState } from "react";
import { api, type User } from "./api";
import { LogoIcon } from "./icons";

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
      <div className="auth-card">
        <div className="brand brand-lg">
          <LogoIcon /> Cloud IDE
        </div>
        <p className="muted auth-tagline">
          Write and run Python in your browser. Your code stays in sync across every tab you
          open.
        </p>

        <form className="auth-form" onSubmit={submit}>
          <h2>{isLogin ? "Sign in" : "Create your account"}</h2>

          <label className="field">
            Email
            <input
              className="text-input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
          </label>

          <label className="field">
            Password
            <input
              className="text-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={isLogin ? "current-password" : "new-password"}
              minLength={8}
              required
            />
          </label>

          {error && <div className="error-banner">{error}</div>}

          <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
            {busy ? "Working…" : isLogin ? "Sign in" : "Create account"}
          </button>
        </form>

        <p className="auth-switch">
          {isLogin ? "New here? " : "Already have an account? "}
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setMode(isLogin ? "register" : "login");
              setError("");
            }}
          >
            {isLogin ? "Create an account" : "Sign in"}
          </button>
        </p>

        <p className="auth-hint">
          Use a throwaway password. Passwords are stored as scrypt hashes, but this is a learning
          build that has never been security reviewed.
        </p>
      </div>
    </div>
  );
}
