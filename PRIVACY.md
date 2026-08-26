# Rosetta — Privacy Policy

_Last updated: 2026-08-26_

Rosetta translates web pages. It has no accounts, no analytics, no telemetry and
no advertising, and its author receives no data from it.

## What leaves your device

This depends entirely on which translation engine you select in the popup.

**Google Translate (default).** The visible text of a page you choose to
translate is sent to Google's translation endpoint (`translate.googleapis.com`)
so that it can be translated. Google's privacy policy governs what happens to it
there. Nothing else is sent: no identifiers, no browsing history, no page URLs,
and no text from pages you have not asked to translate.

**OPUS-MT (offline).** Nothing is sent anywhere. The translation model runs
inside your browser and page text never leaves your device.

The offline model's files are downloaded once from `huggingface.co`, and only
when you click **Download model**. That request reveals your IP address to
Hugging Face, as any file download would. It contains no page content and says
nothing about which pages you visit.

## What is stored, and where

On your device only, in extension storage:

- **Settings** — target language, chosen engine, auto-translate rules.
- **A translation cache** — source strings and their translations, so the same
  text is not translated twice. This is keyed by text and language, not by page
  or site, and it holds no URLs or timestamps.
- **The offline model's weights**, if you downloaded them, in the browser cache.

All of it can be cleared from the popup: **clear** next to the cache figure, and
**remove** next to the model. Nothing is stored on any server.

## What is never collected

No personally identifying information, no credentials, no financial data, no
location data, no browsing history, no keystrokes, no mouse or scroll activity.
No data is sold or transferred to third parties, and none is used for
advertising, credit or lending purposes.

## Which pages Rosetta can read

Rosetta's content script is present on all sites so that it can translate
whichever page you ask it to. It reads a page's text only when you start a
translation — by clicking **Translate page**, or through an auto-translate rule
you set up yourself — and it sends that text onward only under the Google
engine, as described above.

## Changes

Material changes to this policy will be published in this file, whose history is
public at https://github.com/wlwatkins/Rosetta.

## Contact

Questions and issues: https://github.com/wlwatkins/Rosetta/issues
