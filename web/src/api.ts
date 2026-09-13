export type User = { id: string; email: string };
export type Project = { id: string; name: string; ownerId: string; createdAt: string };
export type RunResult = {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  exitCode: number | null;
};

/** Carries the HTTP status, so callers can tell "signed out" (401) apart
 *  from "server down" without parsing messages. */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Throws with the server's message so callers can render it directly. The
 *  server never puts internals in `error`, so this is safe to show. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    // Only claim a JSON body when there is one. Fastify rejects an empty body
    // that's labelled application/json — which silently broke logout, the one
    // POST here without a body.
    headers: init?.body ? { "Content-Type": "application/json" } : {},
    signal: AbortSignal.timeout(30000),
    // Every response here depends on the session cookie, so none of it is
    // safe to cache.
    cache: "no-store",
    ...init,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(body?.error ?? `Request failed (${res.status})`, res.status);
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
