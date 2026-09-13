// The only origin and host names this server answers to. Local-dev values:
// the browser always reaches us through the Vite proxy on :5173.
export const ALLOWED_ORIGIN = "http://localhost:5173";
export const ALLOWED_HOSTS = new Set(["127.0.0.1:3001", "localhost:3001"]);
