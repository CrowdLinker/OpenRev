import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.OPENREV_API || "http://localhost:3000";

export default defineConfig({
  root: "src/dashboard",
  publicDir: "public",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../../dist/public",
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": api,
      "/js": api,
      "/mcp": api,
    },
  },
});
