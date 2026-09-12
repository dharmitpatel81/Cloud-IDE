export type User = { id: string; email: string };
export type Project = { id: string; name: string; ownerId: string; createdAt: string };
export type RunResult = {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  exitCode: number | null;
};

/** Throws with the server's message so callers can render it directly. The
 *  server never puts internals in `error`, so this is safe to show. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30000),
    ...init,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  me: () => request<User>("/auth/me"),
  register: (email: string, password: string) =>
    request<User>("/auth/register", { method: "POST", body: JSON.stringify({ email, password }) }),
  login: (email: string, password: string) =>
    request<User>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  logout: () => request<{ ok: true }>("/auth/logout", { method: "POST" }),

  listProjects: () => request<Project[]>("/projects"),
  createProject: (name: string) =>
    request<Project>("/projects", { method: "POST", body: JSON.stringify({ name }) }),
  getProject: (id: string) => request<Project>(`/projects/${id}`),

  run: (code: string) =>
    request<RunResult>("/run", { method: "POST", body: JSON.stringify({ code }) }),
};
