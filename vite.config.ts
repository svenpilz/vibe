import { defineConfig } from "vite";
import { statSync, existsSync, createReadStream, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const DATA_DIR = join(process.cwd(), "data");

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".jsonl.gz": "application/gzip",
  ".gz": "application/gzip",
  ".geojson": "application/geo+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const pluginServeData = () => ({
  name: "serve-data",
  configureServer(server: any) {
    server.middlewares.use((req: any, res: any, next: any) => {
      const url = (req.url ?? "").split("?")[0];
      if (!url.startsWith("/data/")) return next();
      const rel = decodeURIComponent(url.slice("/data/".length));
      const filePath = normalize(join(DATA_DIR, rel));
      if (!filePath.startsWith(normalize(DATA_DIR))) {
        res.statusCode = 403;
        return res.end("forbidden");
      }
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        res.statusCode = 404;
        return res.end("not found");
      }
      res.setHeader("Content-Type", mimeTypes[extname(filePath)] ?? "application/octet-stream");
      res.setHeader("Content-Length", statSync(filePath).size);
      createReadStream(filePath).pipe(res);
    });
  },
});

export default defineConfig({
  base: "./",
  plugins: [
    pluginServeData(),
    {
      name: "copy-data",
      apply: "build",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "data/map.jsonl.gz",
          source: readFileSync(join(process.cwd(), "data", "map.jsonl.gz")),
        });
      },
    },
  ],
});
