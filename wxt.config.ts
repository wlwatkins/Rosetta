import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'wxt';

// Firefox-only manifest keys. AMO rejects an MV3 upload without an explicit
// add-on ID, and requires a data-collection declaration for new submissions.
//
// The ID is permanent: once a version is uploaded under it, AMO owns that
// string forever, and changing it later creates a *different* add-on rather
// than an update. Pick it before the first submission, not after.
//
// `websiteContent` is the honest declaration — the text of the page is sent to
// Google's endpoint to be translated. 115.0 is the first Firefox with
// `storage.session`, which background.ts relies on.
const gecko = {
  id: 'rosetta@wlwatkins.github.io',
  strict_min_version: '115.0',
  data_collection_permissions: { required: ['websiteContent'] },
} as const;

export default defineConfig({
  modules: ['@wxt-dev/module-svelte'],
  hooks: {
    // Vite emits its own hashed copy of the ONNX Runtime WASM binary, because
    // onnxruntime-web references it with `new URL(..., import.meta.url)`. The
    // runtime is served from public/wasm instead (see wasmPaths in
    // utils/opus-runtime.ts), so that copy is 21 MB nothing ever loads — dead
    // weight in the package and one more large binary for AMO's validator to
    // chew through.
    'build:done': (wxt) => {
      const dir = join(wxt.config.outDir, 'assets');
      if (!existsSync(dir)) return;
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.wasm')) continue;
        const path = join(dir, file);
        wxt.logger.info(`Dropped unused ${file} (${(statSync(path).size / 1e6).toFixed(0)} MB)`);
        rmSync(path);
      }
    },
  },
  zip: {
    // The sources ZIP AMO asks for is source code, not fixtures. Without this
    // it swallows the converted model, the downloaded upstream weights and the
    // WASM runtime — 1.7 GB, well past AMO's limit.
    excludeSources: ['model/**', 'opus/**', 'public/wasm/**', 'docs/**'],
  },
  // Auto-imports off. Every file here imports explicitly, and the scanner
  // can't see function-parameter bindings: a parameter named `translate`
  // matched the `translate` exported by utils/opus-runtime, so it injected an
  // import of the model runtime into utils/cache.ts — and from there into the
  // background service worker, as 58 MB of transformers.js and inlined WASM.
  imports: false,
  vite: () => ({
    build: {
      // modulepreload links never match in extension pages ("cross-world
      // resource mismatch" console spam) — chunks are small, just skip them.
      modulePreload: false,
    },
  }),
  // A function, so `browser_specific_settings` only lands in the Firefox
  // build — Chrome logs it as an unrecognised key.
  manifest: ({ browser }) => ({
    name: 'Rosetta',
    description: 'Translate any page in place, translating only what you can actually see',
    permissions: [
      'storage',
      'unlimitedStorage',
      'activeTab',
      'tabs',
      // Chromium-only: hosts the offline OPUS-MT model, which needs a DOM and
      // a lifetime longer than a service worker's.
      ...(browser === 'firefox' ? [] : ['offscreen']),
    ],
    host_permissions: [
      'https://translate.googleapis.com/*',
      // Where the offline model's weights are fetched from, once. Large files
      // redirect from huggingface.co to its CDN, so the redirect targets need
      // granting too.
      //
      // These match SOURCE in utils/opus-runtime.ts. Switching that to the
      // 'github' fallback also needs 'https://github.com/*' and
      // 'https://objects.githubusercontent.com/*' added back here, or the
      // download fails with an opaque network error.
      'https://huggingface.co/*',
      'https://*.hf.co/*',
      'https://cdn-lfs.huggingface.co/*',
      'https://cdn-lfs-us-1.huggingface.co/*',
    ],
    // ONNX Runtime needs to compile WebAssembly. The binaries themselves ship
    // inside the extension (see scripts/copy-ort-wasm.mjs) because MV3 does not
    // allow loading executable code from a CDN.
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    ...(browser === 'firefox' ? { browser_specific_settings: { gecko } } : {}),
  }),
});
