// Loads the Triangle WASM module for tests running under Node/tsx: resolves
// the .wasm file inside node_modules and hides the global fetch during init so
// Emscripten falls back to reading the file from disk. Import this module
// before any test that calls into src/gl.ts triangulation.
import { createRequire } from "node:module";
import { initTriangulation } from "../src/gl";

const req = createRequire(import.meta.url);
const wasmPath = req
  .resolve("triangle-wasm/package.json")
  .replace(/package\.json$/, "triangle.out.wasm");

const realFetch = globalThis.fetch;
(globalThis as Record<string, unknown>).fetch = undefined;
try {
  await initTriangulation(wasmPath);
} finally {
  (globalThis as Record<string, unknown>).fetch = realFetch;
}
