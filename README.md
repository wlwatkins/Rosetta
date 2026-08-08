# Rosetta

A Chromium MV3 extension (Brave/Chrome/Edge) that translates the current page **in place**,
preserving layout, with a strong bias toward only translating what you can actually see.

Built for Hebrew↔English, works for any pair the chosen backend supports.

## Backends

| Backend | Speed | Notes |
|---|---|---|
| **Google Translate** *(default)* | ~30ms/string | Free, no API key. Uses Google's public `translate_a` endpoint — the one their own site and app use. Undocumented, IP rate-limited, and cloud-based (page text leaves your machine). The officially sanctioned alternative is Cloud Translation: a GCP project with 500k chars/month free. |
| **LM Studio** | ~1s/string on GPU | Local LLM at `http://localhost:1234`. Best quality (DictaLM-3.0-Nemotron-12B-Instruct is excellent for Hebrew). Rosetta lists and loads models itself through LM Studio's REST API with per-model tuned parameters. |
| **Browser built-in** | on-device | Chrome 138+ Translator API. **Not in Brave** — Brave ships the translation engine for its own translate feature but doesn't expose the JS API. Chrome also only supports a fixed set of language pairs (Hebrew is often unavailable). |

## How it translates

- **Visible-first.** Text is only sent when its element is actually on screen: `IntersectionObserver`
  for geometry plus `Element.checkVisibility()` for CSS visibility (a closed menu that still occupies
  layout is not "visible"). Visibility is re-checked again at send time, because SPA reflow can move
  an element out of view between queueing and sending.
- **Reveal-aware.** Opening a menu or accordion triggers a recheck, so its text translates on the spot.
- **Dynamic content.** A `MutationObserver` feeds newly rendered DOM into the same queue.
- **In-place swap.** Only text nodes are replaced, so markup, links and layout survive.
- **Nothing wasted.** Strings with no letters (prices, counts, `•`) and — when translating to English
  — already-ASCII strings never reach a model.
- **Paused when hidden.** No work happens while the tab is in the background.
- **Cancel means cancel.** Aborts in-flight HTTP and interrupts local inference mid-generation.

## Cache

Translations persist in `storage.local`, keyed by **target language and source string** — not by
backend — so a string translated once is reused no matter which engine produced it, across pages,
tabs and browser restarts. Writes go through immediately (an MV3 service worker can be killed at any
moment, and a debounced write loses whole runs). The popup shows coverage for the current page and
has a clear button.

## UI

Toolbar popup: backend, target language, Translate / Cancel / Restore, batch progress, per-tab
"auto-translate on load", cache stats. Text currently in the pipeline shimmers blue. The toolbar
badge shows `…` while translating, `✓` when done, `!` on error.

## Setup

```sh
npm install
npm run build      # -> .output/chrome-mv3
npm run zip        # -> .output/rosetta-<version>-chrome.zip
```

Load in Brave/Chrome: `brave://extensions` → Developer mode → Load unpacked → `.output/chrome-mv3`.

### LM Studio backend

Start the server (Developer tab). Rosetta's Settings panel lists your models and loads the selected
one with tuned parameters — context length, flash attention, KV cache on GPU. It deliberately never
sends a GPU layer count so LM Studio auto-fits the model to VRAM; a manual "all layers" override
makes fitting abort and silently spills the model to CPU (that alone cost ~5× throughput here).

Per-model profiles live in `utils/lmstudio.ts`. Models that can't disable reasoning get extra output
budget: DictaLM-3.0-1.7B-Thinking, for example, hard-appends `<think>` in its prompt template, so
reasoning cannot be turned off at all.
