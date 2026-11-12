/** git commit id injected at build time (vite.config.ts) */
declare const __COMMIT__: string;

/** bundler-emitted URL of a .wasm asset (vite `?url` import) */
declare module "*.wasm?url" {
  const url: string;
  export default url;
}

declare module "triangle-wasm" {
  export interface TriangulateIOData {
    pointlist?: number[];
    segmentlist?: number[];
    holelist?: number[];
  }
  export interface TriangulateIO {
    pointlist: Float64Array;
    trianglelist: Int32Array;
  }
  export function init(path?: string): Promise<void>;
  export function triangulate(
    switches: string | Record<string, unknown>,
    input: TriangulateIO,
    output: TriangulateIO,
  ): void;
  export function makeIO(data?: TriangulateIOData): TriangulateIO;
  export function freeIO(io: TriangulateIO, all?: boolean): void;
}
