# Contributing to openloops

openloops is a local-first Chrome extension: no servers, no accounts, no telemetry. Please keep it that way. Any change that introduces a network call, a remote dependency for core functionality, or data collection outside of the explicit opt-in AI labeling feature will not be merged.

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
1. **Scan my history** — backfills 14 days
2. **Build sessions** — segments and extracts keywords
3. **Build intent map** — clusters and scores

Use **Chrome DevTools → Application → IndexedDB → openloops** to inspect the three stores (`raw_events`, `sessions`, `intent_threads`) directly.

## Architecture

The extension runs a single local pipeline with no backend:

```
chrome.history + tabs.onUpdated
        │
        ▼
   raw_events  (IndexedDB)
        │  noise filter
        ▼
    sessions   (IndexedDB)
        │  ambient detection + clustering + scoring
        ▼
intent_threads (IndexedDB)
        │
        ▼
  React dashboard
        │  optional opt-in
        ▼
  AI labeling (Claude Haiku, user's own key)
```

Each stage is a separate module and a separate IndexedDB object store. Stages are independently inspectable and independently re-runnable. See [CLAUDE.md](./CLAUDE.md) for detailed notes on every phase, including all tunable constants and the rationale behind each design decision.

## Optional API keys

openloops has two optional enrichment features, each requiring its own API key:

- **context.dev** — brand enrichment: resolves domain names into company records (logo, brand color, industry, description). Results are cached in the thread object in IndexedDB, so subsequent runs do not re-fetch the same domains. Calls are batched and rate-limited in `src/pipeline/enrich.ts`.
- **Anthropic (Claude Haiku 4.5)** — AI labeling: one batched call per "Label with AI" click, sending keywords, domains, and enriched descriptions. No streaming; the call returns a JSON array covering all threads.

**Core contributions do not require either key.** The pipeline (capture → sessions → clustering → scoring) runs entirely on-device. You can develop and test everything through "Build intent map" without any API credentials. If your change touches `enrich.ts` or `label.ts`, you'll need the relevant key to run it end-to-end; otherwise you're clear.

## Coding conventions

- **TypeScript everywhere.** No `any`, no type assertions without a clear comment explaining why.
- **One pipeline stage per file** under `src/pipeline/`. Do not mix concerns across stages.
- **Readable over clever.** Prefer clear variable names and a short inline comment when the _why_ is non-obvious over clever one-liners that require a second read.
- **Tunables as named constants.** `SESSION_GAP_MS`, `SIMILARITY_THRESHOLD`, `UBIQUITY_THRESHOLD`, blocklists, stopword lists — all are named exports at the top of their module. Never magic numbers inline.
- **No premature abstraction.** Don't build helper utilities for hypothetical future use. Three similar lines is better than a premature abstraction.
- **No new npm dependencies** for core pipeline logic. The pipeline uses only the Chrome extension APIs, `idb`, and standard TypeScript. Lightweight additions for the dashboard (React already present) can be considered case-by-case.

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