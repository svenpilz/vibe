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
  build: {
    rollupOptions: {
      output: {
        // Stable (hashless) file names: GitHub Pages caches index.html for
        // ~10 min, and hashed asset names are replaced on every deploy, so a
        // cached index.html would reference a deleted JS file and the page
        // would be dead until the cache expires. Pages revalidates all files
        // within 10 min anyway, so content hashing buys nothing here.
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name].[ext]",
      },
    },
  },
  plugins: [],
  worker: {
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name].[ext]",
      },
    },
  },
  define: {
    __COMMIT__: JSON.stringify(commit),
  },
});
