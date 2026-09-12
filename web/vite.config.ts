import { createLogger, defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite logs every proxied WebSocket close as an error, including ordinary ones
// (page reload, HMR, React StrictMode's deliberate remount). Those are noise.
// ECONNREFUSED is kept, because that one means the backend is actually down.
const logger = createLogger();
const viteError = logger.error;
logger.error = (msg, options) => {
  const benignSocketClose = /ws proxy/.test(msg) && /ECONNABORTED|ECONNRESET/.test(msg);
  if (benignSocketClose) return;
  viteError(msg, options);
};

export default defineConfig({
  customLogger: logger,
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      "/collab": {
        target: "ws://127.0.0.1:3001",
        ws: true,
        // Rewrites Host to 127.0.0.1:3001, which the server's DNS-rebinding
        // check expects. It doesn't touch Origin, which is checked separately.
        changeOrigin: true,
      },
    },
  },
});
