import { useState } from "react";
import { api, type User } from "./api";

export function AuthForm({ onSignedIn }: { onSignedIn: (user: User) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const user = mode === "login"
        ? await api.login(email, password)
        : await api.register(email, password);
      onSignedIn(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card auth-form" onSubmit={submit}>
      <h3>{mode === "login" ? "Sign in" : "Create an account"}</h3>

      <label>
        Email
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          required
        />
      </label>

      <label>
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          minLength={8}
          required
        />
      </label>

      {error && <div className="error-banner">{error}</div>}

      <button className="run-btn" type="submit" disabled={busy}>
        {busy ? "Working..." : mode === "login" ? "Sign in" : "Create account"}
      </button>

      <button
        type="button"
        className="link-btn"
        onClick={() => {
          setMode(mode === "login" ? "register" : "login");
          setError("");
        }}
      >
        {mode === "login" ? "Need an account? Register" : "Already have an account? Sign in"}
      </button>

      <p className="hint">
        Use a throwaway password. This project stores a scrypt hash, but it is a
        learning build and has never been security reviewed.
      </p>
    </form>
  );
}
