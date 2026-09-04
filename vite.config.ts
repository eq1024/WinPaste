import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1422,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
        protocol: "ws",
        host,
        port: 1421,
      }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Split heavy vendor libraries into their own chunks: the startup
        // entry stays small (it only loads what the list/shell needs), each
        // vendor chunk is below the size warning, and app-code changes don't
        // invalidate the vendor cache.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("framer-motion")) return "motion";
          if (id.includes("react-select")) return "settings-vendor";
          if (id.includes("react-virtuoso")) return "list-vendor";
          if (id.includes("lucide-react")) return "icons";
          if (id.includes("@tauri-apps")) return "tauri";
          if (id.includes("react")) return "react";
          // Small helpers (clsx, zustand, tailwind-merge…) stay in the entry
          // chunk — splitting them out created a react <-> vendor circular
          // chunk for no size benefit.
          return undefined;
        }
      }
    }
  }
}));
