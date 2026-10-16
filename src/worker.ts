/// <reference lib="webworker" />
/**
 * Web worker: receives an .osm.pbf File/ArrayBuffer, parses and extracts
 * micromapping features off the main thread, posts progress + results.
 *
 * Messages in:  { type: "parse", buffer: ArrayBuffer, name?: string }
 * Messages out: { type: "progress", phase, pct, msg }
 *               { type: "done", result }
 *               { type: "error", message }
 */
import { OSMPBFParser, createOSMData } from "./osm-pbf";
import { extractFeatures } from "./extract";
import type { ExtractResult } from "./extract";

export interface WorkerIn {
  type: "parse";
  buffer: ArrayBuffer;
  name?: string;
}
export type WorkerOut =
  | { type: "progress"; phase: string; pct: number; msg: string }
  | { type: "done"; result: ExtractResult }
  | { type: "error"; message: string };

const post = (m: WorkerOut) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const msg = e.data;
  if (msg.type !== "parse") return;

  try {
    const buf = new Uint8Array(msg.buffer);
    const data = createOSMData();
    const parser = new OSMPBFParser(
      data,
      (tags) =>
        tags["barrier"] === "kerb" ||
        tags["kerb"] !== undefined ||
        tags["traffic_calming"] !== undefined,
      (pct, stats) =>
        post({ type: "progress", phase: "parsing PBF", pct: pct * 0.8, msg: stats })
    );
    await parser.parseBuffer(buf);

    const result = extractFeatures(data, (pct, m) =>
      post({ type: "progress", phase: "extracting features", pct: 80 + pct * 0.2, msg: m })
    );

    post({ type: "done", result });
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
