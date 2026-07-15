import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

// In Docker, nginx reverse-proxies /api -> backend, so no dev proxy is needed
// there. For standalone `npm run dev` (no nginx), set VITE_DEV_API_TARGET
// (e.g. http://localhost:4000) so relative /api/* calls resolve to the backend.
const apiTarget = process.env.VITE_DEV_API_TARGET;

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  server: {
    port: 5173,
    ...(apiTarget
      ? {
          proxy: {
            "/api": {
              target: apiTarget,
              changeOrigin: true,
            },
          },
        }
      : {}),
  },
  build: {
    // Split heavy vendor code so the initial route stays lean.
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-motion": ["framer-motion"],
          "vendor-query": ["@tanstack/react-query"],
        },
      },
    },
  },
});
