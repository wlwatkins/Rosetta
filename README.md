# Rosetta

A Chromium MV3 extension (Brave/Chrome/Edge) that translates the current page **in place**,
preserving layout, and only translates what you can actually see.

Built for Hebrew→English; works for any pair Google Translate supports.

## Translation engines

Pick one in the popup. The queue, the cache, progress, cancel and the auto-translate rules work the
same either way.

| | **Google Translate** | **OPUS-MT** |
|---|---|---|
| Pairs | anything in the language list | Hebrew → English only |
| Where it runs | Google's servers | this machine |
| Page text leaves the machine | yes | no |
| Speed | ~30 ms per string | ~0.3 s per string, one CPU thread |
| Setup | none | one-time ~365 MB download |
| Browser | any | any (Chromium via the offscreen API, Firefox via a background iframe) |

**Google** uses the public `translate_a` endpoint — the one their own site and app use. No API key,
excellent quality. It is undocumented and rate-limited by IP. The officially sanctioned upgrade is
Cloud Translation (a GCP project, 500k chars/month free, then $20/million) — a small change to
`utils/providers.ts`.

**OPUS-MT** runs [`Helsinki-NLP/opus-mt-tc-big-he-en`](https://huggingface.co/Helsinki-NLP/opus-mt-tc-big-he-en)
— Marian transformer-big, 0.2B params, CC-BY-4.0, 53.8 BLEU on Tatoeba — in this browser through ONNX
Runtime. Page text is never sent anywhere.

The weights are **hosted, not bundled**: int8 is ~365 MB, which alone exceeds Firefox's 200 MB add-on
limit and would make every extension update a full re-download. They are fetched once, on demand,
and kept in the browser's cache; **Remove** in the popup deletes them.

They are not the published ONNX files, because every published export of this pair is broken. `q4`
is an invalid graph (int4 tensors into `MatMulInteger`, which is defined for int8/uint8 — ONNX
Runtime refuses it at session creation), `fp16` fails at run time because transformers.js feeds it
fp32 inputs, and `fp32` is 1.2 GB. No int8 export exists, so this one was made with
`scripts/convert-opus-int8.py`, which writes to `model/` — git-ignored, since GitHub rejects files
over 100 MB. Regenerate it with the script rather than committing it.

`SOURCE` in `utils/opus-runtime.ts` picks where the weights come from:

| Source | Where | Notes |
|---|---|---|
| `github` | a GitHub **release** | Releases take files up to 2 GB, unlike the repo's 100 MB limit, but they are a flat namespace — hence `subfolder: ''`, which makes transformers.js ask for bare filenames |
| `huggingface` *(default)* | [`wlwatkins/opus-mt-tc-big-he-en`](https://huggingface.co/wlwatkins/opus-mt-tc-big-he-en) | transformers.js's native layout; nothing to configure |
| `mul-en` | [`Xenova/opus-mt-mul-en`](https://huggingface.co/Xenova/opus-mt-mul-en) | Needs nothing published. Two thirds smaller, but a general multilingual model rather than a Hebrew specialist, so visibly rougher English |

Only six files are ever requested — `config.json`, `generation_config.json`, `tokenizer.json`,
`tokenizer_config.json`, `encoder_model_quantized.onnx`, `decoder_model_merged_quantized.onnx`. The
`.spm` and `vocab.json` files in `model/` are never fetched; `tokenizer.json` supersedes them.

Measured on the int8 model: ~24 s to build the sessions on first use, then ~0.3 s per short string on
one CPU thread. Cached strings are free. See [docs/benchmark.md](docs/benchmark.md) for quality
against the original fp32 model.

### How the offline engine is wired

The model can't live in the service worker: MV3 workers have no DOM (so no WASM backend) and are
killed on idle, which would mean rebuilding the sessions constantly. It needs a context with a DOM
and a longer life, and the two browsers offer different ones:

- **Chromium** has the `offscreen` API — a real hidden document, created on demand.
- **Firefox** has no offscreen API, but its MV3 background is an event *page* with a DOM, so the
  same `offscreen.html` is hosted there in a hidden iframe.

Either way it is the same document, the same code and the same message protocol
(`utils/opus.ts` → `entrypoints/offscreen/`), so both builds ship identical files. The only manifest
difference is the one the platforms force: Chromium takes `background.service_worker`, Firefox
requires `background.scripts`.

Four details matter for output quality, and each one was a visible bug before it was a line of code:

- **int8 runs on the CPU backend, never the GPU.** ONNX Runtime's WebGPU (JSEP) backend dequantises
  int8 weights incorrectly ([transformers.js#1512](https://github.com/huggingface/transformers.js/issues/1512)),
  so a q8 model on the GPU returns fluent-looking multilingual nonsense instead of a translation.
  Every int8 preset pins `device: 'wasm'`.
- **No `no_repeat_ngram_size`, no `repetition_penalty`.** Both read as sensible anti-degeneracy
  guards and both corrupt output here. In a batch, a short string finishes early and keeps stepping
  while the longest member runs on, re-emitting EOS; forbidding that repeated n-gram forces real
  tokens out instead, so "Tourism" comes back as `Tourism....!?:-)s,];`. `max_new_tokens` is the
  only guard, and it bounds how long one string can hold up its batch.
- **Sentences, not paragraphs.** Marian was trained on single sentences and degrades badly on longer
  input, so anything over ~220 characters is split with `Intl.Segmenter` and rejoined after.
- **One batch at a time.** Four concurrent requests make sense over a network and none at all
  against a single CPU, so the content script's in-flight limit is per engine.

The cache namespaces the two engines separately (`EN` vs `EN~opus`): offline mode showing text that
originally came from Google would quietly undo the point of it.

## How it translates

- **Visible-first.** Text is only sent when its element is actually on screen: `IntersectionObserver`
  for geometry plus `Element.checkVisibility()` for CSS visibility, so a closed menu that still
  occupies layout is not "visible". Visibility is re-checked again at send time, because SPA reflow
  can move an element out of view between queueing and sending.
- **Reveal-aware.** Opening a menu or accordion triggers a recheck, so its text translates on the spot.
- **Dynamic content.** A `MutationObserver` feeds newly rendered DOM into the same queue.
- **Iframes.** The content script runs in every frame (`all_frames`), so pages that host their real
  content in an iframe are translated too. Each frame keeps its own queue; the popup talks to the
  main frame (`frameId: 0`) for status, and Translate / Cancel / Restore broadcast to all frames.
- **In-place swap.** Only text nodes are replaced, so markup, links and layout survive. Originals are
  kept in memory, so **Restore** works without a reload.
- **Attributes and the tab title too.** Text in `placeholder`, `title`, `aria-label` and `alt` is
  translated, as is `document.title`, so search boxes, tooltips, screen-reader labels and the
  browser tab don't stay in the original language.
- **Nothing wasted.** Strings with no letters (prices, counts, `•`) and — when translating to English
  — already-ASCII strings never leave the browser.
- **Paused when hidden.** No work happens while the tab is in the background.
- **Cancel means cancel.** Aborts in-flight requests rather than waiting for the current batch.
- Up to 4 requests in flight, 40 strings or 2000 characters each.

## Cache

Translations persist in `storage.local`, keyed by **engine, target language and source string**, so a
string translated once is reused across pages, tabs and browser restarts. Writes go
through immediately: an MV3 service worker can be killed at any moment, and a debounced write loses
whole runs. The popup shows coverage for the current page and has a clear button.

## UI

Toolbar popup: engine, model status and download, target language, Translate / Cancel / Restore, per-tab "auto-translate on load"
(which also translates the current page immediately), a global **"always translate pages written in
&lt;language&gt;"** rule, batch progress, elapsed time, cache stats.

The global rule detects the page's language with `browser.i18n.detectLanguage` and only fires on a
confident match (≥60%, and only with enough text to judge), so an English page with a Hebrew heading
is left alone.
Text currently in the pipeline shimmers blue. The toolbar badge shows `…` while translating, `✓`
when done, `!` on error.

## Build

```powershell
.\build.ps1                 # prompts for a version, type-checks, builds, zips
.\build.ps1 -Version 1.2.0  # non-interactive
.\build.ps1 -NoZip          # skip packaging
```

Or directly: `npm install`, then `npm run build` (→ `.output/chrome-mv3`) and `npm run zip`.
For Firefox/Android: `npm run build:firefox` (→ `.output/firefox-mv3`) and `npm run zip:firefox`.

The build copies ONNX Runtime's WebAssembly binaries into `public/wasm` first (`npm run copy:wasm`),
because MV3 won't load executable code from a CDN. That folder is generated and git-ignored.

The Firefox target is a separate build, not a repackage of the Chrome one: AMO rejects
`background.service_worker` without a `background.scripts` fallback, and requires an explicit add-on
ID and a data-collection declaration. Those live in `wxt.config.ts` under `gecko` — **the ID is
permanent once a version is uploaded**, so set it before the first submission.

## For AMO reviewers

The submitted package is bundled and minified from TypeScript and Svelte, so the sources ZIP is
required. To reproduce the build:

```
npm install
npm run zip:firefox
```

Node 22, npm 10. `npm run zip:firefox` runs `scripts/copy-ort-wasm.mjs` first, which copies ONNX
Runtime's WebAssembly binary out of `node_modules/onnxruntime-web/dist` into `public/wasm/`; it is
not committed, which is why it appears in the package but not in the sources ZIP.

Three things a reviewer is likely to ask about:

- **`'wasm-unsafe-eval'` in the CSP.** ONNX Runtime compiles WebAssembly. The binary ships inside the
  package (`wasm/ort-wasm-simd-threaded.jsep.wasm`) precisely so that no executable code is fetched
  at run time — MV3 forbids that, and the extension does not do it.
- **The translation model is not in the package.** It is ~365 MB and is downloaded on first use, only
  if the user explicitly clicks "Download model", from
  [`wlwatkins/opus-mt-tc-big-he-en`](https://huggingface.co/wlwatkins/opus-mt-tc-big-he-en) — an int8
  ONNX export of `Helsinki-NLP/opus-mt-tc-big-he-en` (CC-BY-4.0). It is cached in the browser and can
  be deleted from the popup. That is what the `huggingface.co` host permissions are for.
- **Data collection.** `websiteContent` is declared because the Google Translate engine sends the
  text of the page to `translate.googleapis.com`. The OPUS-MT engine sends nothing: it runs entirely
  in the browser, which is the reason it exists.

## Install — desktop

**Brave / Chrome / Edge**

1. Open `brave://extensions` (or `chrome://extensions`, `edge://extensions`).
2. Turn on **Developer mode**.
3. **Load unpacked** → select `.output/chrome-mv3`.

Reloading after a rebuild: press ↻ on the Rosetta card. If the manifest changed (permissions, name),
remove the extension and load it again.

Unpacked extensions are identified by their folder path, so moving the project gives Rosetta a new
identity and it starts with an empty cache and default settings.

**Firefox**

`about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → pick any file inside
`.output/firefox-mv3`. Temporary add-ons are removed when Firefox closes; for a permanent install the
add-on has to be signed by Mozilla (see below).

**Keeping several desktop machines in sync**

Publish to the Chrome Web Store with **Unlisted** visibility: a one-time $5 developer fee, no public
listing, installable on any Chromium desktop from its URL, and it auto-updates. Note it still goes
through Google's review — and this extension calls Google's undocumented `translate_a` endpoint,
which their terms don't sanction for third-party use, so switch to Cloud Translation first if you
intend to publish.

## Install — phone and tablet

Mobile support depends entirely on the browser, and most don't allow extensions at all.

| Platform | Status |
|---|---|
| Chrome for Android | No extension support, and Google has said it isn't planned |
| Brave for Android | No extension support yet (under discussion) |
| Firefox for Android | **Works** — via a custom add-on collection |
| Chromium forks (Yandex, Lemur, Quetta…) | Install the `chrome-mv3` build like on desktop |
| iOS / iPadOS Safari | Needs a native app wrapper: Xcode plus an Apple Developer account ($99/yr) |
| iOS Orion browser | Runs Chrome extensions directly |

**Firefox for Android**

1. Build the Firefox target and zip it (see above).
2. Sign in at [addons.mozilla.org](https://addons.mozilla.org), submit the zip as an **unlisted**
   add-on, and let Mozilla sign it. Unlisted add-ons aren't published or searchable.
3. Create a **collection** on AMO containing it, and note the collection name and your numeric user ID.
4. In Firefox Android: **Settings → About Firefox**, tap the logo five times to reveal the debug menu,
   then **Settings → Advanced → Custom Add-on collection** and enter that user ID and collection name.
   Firefox restarts, and Rosetta appears under **Add-ons**.

The Firefox build is the same code minus nothing: the only backend is a plain HTTPS call, so it
behaves identically on mobile.

## Layout

| Path | Purpose |
|---|---|
| `entrypoints/content.ts` | Visibility queue, DOM text swap, batching, shimmer |
| `entrypoints/background.ts` | Message router, per-tab state, toolbar badge |
| `entrypoints/popup/` | Svelte 5 popup |
| `entrypoints/offscreen/` | Host for the offline model (DOM + WebGPU + a long life) |
| `utils/providers.ts` | Engine dispatch, Google endpoint, cancellation |
| `utils/opus.ts` | Background-side handle on the offscreen document |
| `utils/opus-runtime.ts` | The OPUS-MT pipeline: loading, batching, generation |
| `utils/cache.ts` | Persistent translation cache |
| `utils/languages.ts` | Target languages, API codes, and what each engine supports |
| `scripts/copy-ort-wasm.mjs` | Bundles the ONNX Runtime WASM binaries |
| `scripts/convert-opus-int8.py` | One-time int8 export of the model, for the offline-and-bundled route |
