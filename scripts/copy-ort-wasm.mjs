// Copies the ONNX Runtime WebAssembly binaries into public/wasm.
//
// transformers.js fetches these from a CDN by default. MV3 forbids loading
// executable code from anywhere but the extension package, so they have to be
// bundled and pointed at with env.backends.onnx.wasm.wasmPaths — see
// utils/opus-runtime.ts.
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

// Resolve the package's main entry rather than its package.json: onnxruntime
// declares an `exports` map with no "./package.json" entry, so asking for that
// path throws. The entry point lives in dist/, which is what we're after.
let dist;
try {
  dist = dirname(require.resolve('onnxruntime-web'));
} catch (err) {
  console.error('onnxruntime-web not found — run `npm install` first.');
  console.error(String(err?.message ?? err));
  process.exit(1);
}

// Only the JSEP runtime, which is the one onnxruntime-web's default bundle
// actually loads — verified by deleting everything else from a build and
// watching it still translate. The plain (non-JSEP) build is another 11 MB
// that nothing requests, and the rest of dist/ is the ORT JavaScript library
// in a dozen flavours the bundler already handles.
//
// If a future onnxruntime-web asks for a file that isn't here, it fails with
// a 404 fetching the .wasm: widen this filter to /^ort-wasm/ to get them all.
const wanted = (await readdir(dist)).filter((f) => f.startsWith('ort-wasm-simd-threaded.jsep.'));
if (wanted.length === 0) {
  console.error(`No ort-wasm* files in ${dist}`);
  process.exit(1);
}

const to = join(process.cwd(), 'public', 'wasm');
await rm(to, { recursive: true, force: true });
await mkdir(to, { recursive: true });
for (const file of wanted) await cp(join(dist, file), join(to, file));

console.log(`copy-ort-wasm: ${wanted.join(', ')} -> public/wasm`);
