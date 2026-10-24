/// <reference lib="webworker" />
/**
 * Web worker: receives an .osm.pbf File/ArrayBuffer, parses and extracts
 * micromapping features off the main thread, posts progress + results.
 *
 * Messages in:  { type: "parse", buffer: ArrayBuffer, name?: string }
 * Messages out: { type: "progress", phase, pct, msg }
 *               { type: "timing", timings: { step: string; sec: number }[] }
 *               { type: "done", result, timings }
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
export interface StepTiming {
  step: string;
  sec: number;
}
export type WorkerOut =
  | { type: "progress"; phase: string; pct: number; msg: string }
  | { type: "timing"; timings: StepTiming[] }
  | { type: "done"; result: ExtractResult; timings: StepTiming[] }
  | { type: "error"; message: string };

const post = (m: WorkerOut) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const msg = e.data;
  if (msg.type !== "parse") return;

  try {
    const timings: StepTiming[] = [];
    const time = (step: string, from: number): void => {
      const sec = (performance.now() - from) / 1000;
      timings.push({ step, sec });
      post({ type: "timing", timings: [...timings] });
    };

    const buf = new Uint8Array(msg.buffer);
    const data = createOSMData();
    let t = performance.now();
    const parser = new OSMPBFParser(
      data,
      (tags) =>
        tags["barrier"] === "kerb" ||
        tags["kerb"] !== undefined ||
        tags["barrier"] === "bollard" ||
        tags["highway"] === "street_lamp" ||
        tags["highway"] === "traffic_signals" ||
        tags["man_made"] === "manhole" ||
        tags["traffic_calming"] !== undefined,
      (pct, stats) =>
        post({ type: "progress", phase: "parsing PBF", pct: pct * 0.8, msg: stats })
    );
    await parser.parseBuffer(buf);
    time("parse PBF", t);

    // each extraction step reports its own progress callback; time the
    // stretch between two callbacks as that step's runtime
    t = performance.now();
    let lastMsg = "start";
    const result = extractFeatures(data, (pct, m) => {
      time(`extract: ${lastMsg}`, t);
      lastMsg = m.replace(/…$/, "");
      t = performance.now();
      post({ type: "progress", phase: "extracting features", pct: 80 + pct * 0.2, msg: m });
    });
    time(`extract: ${lastMsg}`, t);

    post({ type: "done", result, timings });
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
