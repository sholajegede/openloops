# Contributing to openloops

openloops is a local-first Chrome extension: no servers, no accounts, no telemetry. Please keep it that way. Any change that introduces a network call, a remote dependency for core functionality, or data collection outside of the explicit opt-in features (brand enrichment, AI labeling, AI assistant) will not be merged.

## Dev setup

**Prerequisites:** Node 18+, Chrome (or Chromium-based browser).

```bash
git clone https://github.com/sholajegede/openloops.git
cd openloops
npm install
npm run dev        # watch mode with HMR via @crxjs/vite-plugin
```

Load the extension:
1. `chrome://extensions` → **Developer mode ON**
2. **Load unpacked** → select the `dist/` folder

After making changes, the extension reloads automatically in dev mode. To test the pipeline end-to-end:
1. **Scan my history** — backfills 14 days (the welcome screen on a fresh DB will point you here first)
2. **Build sessions** — segments and extracts keywords
3. **Build intent map** — clusters and scores, producing the status-grouped intent map

Use **Chrome DevTools → Application → IndexedDB → openloops** to inspect the four stores (`raw_events`, `sessions`, `intent_threads`, `domain_brands`) directly.

## Architecture

The extension runs a single local pipeline with no backend:

```
chrome.history + tabs.onUpdated
        │
        ▼
   raw_events  (IndexedDB)
        │  noise filter (incl. localhost / private IPs)
        ▼
    sessions   (IndexedDB)
        │  ambient detection + clustering + scoring
        ▼
intent_threads (IndexedDB)
        │
        ▼
  React dashboard (rail · intent map · assistant)
        │  optional, opt-in — "Label & enrich"
        ├──→ brand enrichment        (context.dev, user's key)
        └──→ AI labeling + next step (Claude, user's key)
                │
                ▼  optional, opt-in
        AI assistant chat (Claude, user's key —
        model + effort selectable)
```

Each stage is a separate module and a separate IndexedDB object store. Stages are independently inspectable and independently re-runnable.

## Optional features and API keys

openloops has three optional features, each gated behind "Save key" in the dashboard's INTELLIGENCE panel and using the user's own API key:

- **AI labeling** (Anthropic/Claude) — adds a title, summary, type, and one concrete next step per thread, in batches of `BATCH_SIZE` (default 10) — see `src/pipeline/label.ts`.
- **AI assistant chat** (Anthropic/Claude) — `src/dashboard/Assistant.tsx`, grounded in thread data, with a model selector (Haiku 4.5 default, Sonnet 4.6, Opus 4.6/4.7/4.8) and an effort selector (Low/Medium/High → `max_tokens`). Uses the same Anthropic key as labeling.
- **Brand enrichment** (context.dev) — resolves domain names into company records (logo, brand color, industry, description), cached in the `domain_brands` IndexedDB store so domains aren't re-fetched. Batched and rate-limited in `src/pipeline/enrich.ts`, and `localhost`/private-IP domains are skipped entirely.

context.dev is purely an enhancement — AI labeling and the assistant both work with just the Anthropic key, and the UI marks the context.dev field as optional.

**Core contributions do not require either key.** The pipeline (capture → sessions → clustering → scoring) runs entirely on-device. You can develop and test everything through "Build intent map" without any API credentials. If your change touches `enrich.ts`, `label.ts`, or `Assistant.tsx`, you'll need the relevant key to run it end-to-end; otherwise you're clear.

## Coding conventions

- **TypeScript everywhere.** No `any`, no type assertions without a clear comment explaining why.
- **One pipeline stage per file** under `src/pipeline/`. Do not mix concerns across stages.
- **Readable over clever.** Prefer clear variable names and a short inline comment when the _why_ is non-obvious over clever one-liners that require a second read.
- **Tunables as named constants.** `SESSION_GAP_MS`, `SIMILARITY_THRESHOLD`, `UBIQUITY_THRESHOLD`, `BATCH_SIZE`, blocklists, stopword lists — all are named exports at the top of their module. Never magic numbers inline.
- **No premature abstraction.** Don't build helper utilities for hypothetical future use. Three similar lines is better than a premature abstraction.
- **New npm dependencies for core pipeline logic are not allowed.** The pipeline uses only the Chrome extension APIs, `idb`, and standard TypeScript. Lightweight, dashboard-only additions are fine case-by-case — `react-markdown` (for rendering the assistant's responses) is the existing example.

## Tuning and extending the blocklists

The easiest contribution is extending the filter lists — they are plain arrays of strings:

| What | Where | How |
|---|---|---|
| Comms/utility domain blocklist | `src/pipeline/noise.ts` → `BLOCKED_DOMAINS` | Add the root domain (e.g. `"notion.so"`); subdomains match automatically |
| Adult content domains | `src/pipeline/noise.ts` → `ADULT_DOMAINS` | Same pattern |
| Tracker/redirect junk | `src/pipeline/noise.ts` → `JUNK_DOMAINS` | Same pattern |
| Platform brand stopwords | `src/pipeline/keywords.ts` → `PLATFORM_STOPWORDS` | Lowercase token strings |
| English function-word stopwords | `src/pipeline/keywords.ts` → `STOPWORDS` | Lowercase strings |

**Tuning clustering:** Lower `SIMILARITY_THRESHOLD` in `src/pipeline/threads.ts` to merge sessions more aggressively (fewer, broader threads). Raise it to fragment more (more, narrower threads). The default is `0.15`. After changing it, rebuild and re-run "Build intent map" — use `console.table` in DevTools on the thread output to inspect before/after.

**Tuning AI labeling:** If you have a very large number of threads and see `console.error` logs about failed/truncated batches, lower `BATCH_SIZE` in `src/pipeline/label.ts` (default 10) so each request has more headroom within `MAX_TOKENS_PER_BATCH`.

## Pull requests

1. Branch off `main`: `git checkout -b my-change`.
2. Make your change. Keep it focused — one concern per PR.
3. Run `npm run build` and confirm it passes cleanly with zero TypeScript errors.
4. Write a clear PR description: what changed, why, and how you tested it. Reference any relevant issue.
5. Open the PR against `main` on [github.com/sholajegede/openloops](https://github.com/sholajegede/openloops).

For larger changes (new pipeline stages, significant refactors), open an issue first to align on approach before writing code.

## Bug reports and ideas

Open an issue on GitHub. For bugs, include:
- Chrome version and OS
- What you did (scan size, pipeline steps run)
- What you expected vs. what happened
- Any relevant output from the DevTools console (filter for `[openloops]`)

For ideas, describe the use case you're trying to solve — not just the feature.