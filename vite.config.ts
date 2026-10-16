import { defineConfig } from "vite";
import { execSync } from "node:child_process";

let commit = "unknown";
try {
  commit = execSync("git rev-parse --short HEAD").toString().trim();
} catch {
  // git not available
}

export default defineConfig({
  base: "./",
  plugins: [],
  define: {
    __COMMIT__: JSON.stringify(commit),
  },
});
