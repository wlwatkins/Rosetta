# Rosetta

A Chromium MV3 extension (Brave/Chrome/Edge) that translates the current page **in place**,
preserving layout, and only translates what you can actually see.

Built for Hebrew→English; works for any pair Google Translate supports.

## Translation engine

Google's public `translate_a` endpoint — the one their own site and app use. No API key, ~30ms per
string, excellent quality.

It is undocumented and rate-limited by IP, and it is cloud-based, so page text leaves your machine.
The officially sanctioned upgrade is Cloud Translation (a GCP project, 500k chars/month free, then
$20/million) — a small change to `utils/providers.ts`.

## How it translates

- **Visible-first.** Text is only sent when its element is actually on screen: `IntersectionObserver`
  for geometry plus `Element.checkVisibility()` for CSS visibility, so a closed menu that still
  occupies layout is not "visible". Visibility is re-checked again at send time, because SPA reflow
  can move an element out of view between queueing and sending.
- **Reveal-aware.** Opening a menu or accordion triggers a recheck, so its text translates on the spot.
- **Dynamic content.** A `MutationObserver` feeds newly rendered DOM into the same queue.
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

Translations persist in `storage.local`, keyed by **target language and source string** — not by
engine — so a string translated once is reused across pages, tabs and browser restarts. Writes go
through immediately: an MV3 service worker can be killed at any moment, and a debounced write loses
whole runs. The popup shows coverage for the current page and has a clear button.

## UI

Toolbar popup: target language, Translate / Cancel / Restore, per-tab "auto-translate on load"
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
For Firefox/Android: `npx wxt build -b firefox` (→ `.output/firefox-mv2`) and `npx wxt zip -b firefox`.

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
`.output/firefox-mv2`. Temporary add-ons are removed when Firefox closes; for a permanent install the
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
| `utils/providers.ts` | Google endpoint, cancellation |
| `utils/cache.ts` | Persistent translation cache |
| `utils/languages.ts` | Target languages and their API codes |
