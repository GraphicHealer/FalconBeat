import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Vendored copy of beatsync/packages/shared — re-copy when bumping the
      // beatsync submodule pin so client + server schemas never drift.
      "@beatsync/shared": fileURLToPath(
        new URL("./src/vendor/beatsync-shared/index.ts", import.meta.url)
      ),
    },
  },
});
