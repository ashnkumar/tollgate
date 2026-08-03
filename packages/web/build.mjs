import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * Bundle the browser client.
 *
 * The output is plain static files, which is what lets the metering server serve the
 * whole UI from the same origin as the API — no dev server, no proxy, no CORS.
 */

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const result = await build({
  entryPoints: [resolve(here, "src/main.ts")],
  outfile: resolve(dist, "app.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  minify: true,
  sourcemap: true,
  metafile: true,
  logLevel: "warning",
});

await cp(resolve(here, "public"), dist, { recursive: true });

const [, script] = Object.entries(result.metafile.outputs).find(([file]) => file.endsWith(".js")) ?? [];
console.log(`web: built app.js (${((script?.bytes ?? 0) / 1024).toFixed(0)} kB) to packages/web/dist`);
