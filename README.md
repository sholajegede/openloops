<p align="center">
  <img src="https://raw.githubusercontent.com/sholajegede/openloops/main/public/openloops-logo.png" alt="openloops logo" width="72" height="72" />
</p>

<h1 align="center">openloops</h1>

<p align="center">
  Your browser records every page you open. It forgets why.<br/>
  <strong>openloops</strong> reconstructs the why — entirely on your machine.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Manifest-V3-4285f4?style=flat-square&logo=googlechrome&logoColor=white" alt="Manifest V3" />
  <img src="https://img.shields.io/badge/Vite-5.x-646cff?style=flat-square&logo=vite&logoColor=white" alt="Vite" />
  <img src="https://img.shields.io/badge/React-18-61dafb?style=flat-square&logo=react&logoColor=black" alt="React 18" />
  <img src="https://img.shields.io/badge/storage-IndexedDB-f7931e?style=flat-square" alt="IndexedDB" />
  <img src="https://img.shields.io/badge/AI%20labeling-Claude%20Haiku%204.5-cc785c?style=flat-square" alt="Claude Haiku 4.5" />
  <img src="https://img.shields.io/badge/100%25%20local-no%20servers-22c55e?style=flat-square" alt="100% local" />
</p>

## What this is

openloops is a local-only Chrome extension that turns raw browsing history into **intent threads** — the open loops you never closed.

Not bookmarks. Not a reading list. Threads: an active decision still in progress, a product you were comparing before you got distracted, a question you keep returning to. openloops surfaces those patterns from what you were actually doing, groups them into coherent research arcs, and scores how alive each thread still is.

Everything runs on-device. The only optional network call is AI labeling, which uses your own Anthropic API key and sends only the clustered page titles — never raw URLs or full page content.

## How it works

```
┌─────────────────────────────────────────────────┐
│                   CAPTURE                        │
│  chrome.history (14-day backfill)                │
│  chrome.tabs.onUpdated (live)                    │
└─────────────────┬───────────────────────────────┘
                  │  raw_events (IndexedDB)
                  ▼
┌─────────────────────────────────────────────────┐
│                NOISE FILTER                      │
│  domain blocklist · generic titles              │
│  platform stopwords · adult/junk domains        │
└─────────────────┬───────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────┐
│             SESSION SEGMENTATION                 │
│  30-minute idle gap splits a new session        │
│  keyword extraction per session                 │
└─────────────────┬───────────────────────────────┘
                  │  sessions (IndexedDB)
                  ▼
┌─────────────────────────────────────────────────┐
│           AMBIENT DOMAIN DETECTION               │
│  ubiquity = distinct days / total active days   │
│  ≥ 0.6 on ≥ 3 days → excluded from clustering  │
└─────────────────┬───────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────┐
│               CLUSTERING                         │
│  greedy agglomerative · Jaccard similarity      │
│  0.5 × domain overlap + 0.5 × keyword overlap   │
└─────────────────┬───────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────┐
│                 SCORING                          │
│  type (buying/research/learning/planning)       │
│  confidence · status · human-readable signals   │
└─────────────────┬───────────────────────────────┘
                  │  intent_threads (IndexedDB)
                  ▼
┌─────────────────────────────────────────────────┐
│              INTENT MAP (dashboard)              │
│  React · full Chrome tab                        │
└─────────────────┬───────────────────────────────┘
                  │  optional, opt-in
                  ▼
┌─────────────────────────────────────────────────┐
│              AI LABELING (opt-in)                │
│  Claude Haiku 4.5 · your key · one batch call   │
│  rewrites title + summary + type per thread     │
└─────────────────────────────────────────────────┘
```

## The pipeline, stage by stage

| Stage | What it does | Where in code |
|---|---|---|
| **Capture** | Backfills 14 days via the History API (`search` + per-URL `getVisits`); live-captures new visits via `tabs.onUpdated`. Skips non-HTTP schemes, deduplicates within 3 s. | `src/pipeline/backfill.ts`, `src/background.ts` |
| **Noise filter** | Drops events matching a domain blocklist (comms tools), adult/junk domains, and generic/navigational titles (e.g. "New Tab", "Loading…"). Also strips platform brand tokens before keyword extraction. | `src/pipeline/noise.ts`, `src/pipeline/keywords.ts` |
| **Sessions** | Splits the event stream into sessions wherever a 30-minute idle gap occurs. Extracts top keywords per session; prunes trivial single-event, zero-keyword sessions. | `src/pipeline/sessions.ts`, `src/pipeline/keywords.ts` |
| **Ambient detection** | Computes per-domain ubiquity (distinct days seen ÷ total active days). Domains present on ≥ 60 % of active days over ≥ 3 days (Google, YouTube, etc.) are excluded from similarity scoring. | `src/pipeline/ambient.ts` |
| **Clustering** | Greedy agglomerative pass over chronological sessions. Similarity = 0.5 × domain Jaccard + 0.5 × keyword Jaccard (over non-ambient domains). Sessions above the threshold join the nearest thread; otherwise they start a new one. Prunes threads with 1 session and fewer than 3 events. | `src/pipeline/threads.ts` |
| **Scoring** | Assigns type via keyword scanning (`BUYING_WORDS`, `LEARNING_WORDS`). Computes confidence from four weighted signals: distinct days (35 %), sessions (25 %), events (20 %), clear type (20 %). Sets status: active < 48 h, stalled < 7 d, dormant otherwise. | `src/pipeline/threads.ts` |
| **AI labeling** | Optional. Sends compact thread descriptors (keywords, domains, sample titles — no raw URLs) to Claude Haiku 4.5 in one batched call. Overwrites title, type, and adds a one-sentence summary per thread. Requires the user's own Anthropic API key. | `src/pipeline/label.ts` |

## Privacy

**All data lives in IndexedDB on your machine.** There are no servers, no accounts, no analytics, no telemetry of any kind.

The **only** data that ever leaves your device is the clustered thread descriptors (keywords, domain names, and a sample of page titles) sent to the Anthropic API when you explicitly click "Label with AI" with your own API key. Even then, raw URLs and full page content are never sent.

Your Anthropic API key is stored in `chrome.storage.local` — on-device, never in the repository, never transmitted anywhere other than to `api.anthropic.com` during labeling.

## The dashboard

The dashboard is a full Chrome tab (not a popup) with three sections:

**Intent Map** — one card per thread, sorted by status then confidence. Each card shows:
- Title (heuristic keyword-derived, or AI-generated after labeling)
- AI summary (one sentence, appears after labeling)
- Type badge (`buying`, `research`, `learning`, `planning`, `unclassified`) and status pill (`active`, `stalled`, `dormant`)
- Confidence bar (0–100 %)
- Session / event / day counts and relative timestamp
- Top domains and keywords
- Signals: human-readable explanations for why the thread scored the way it did

**Sessions** — the full list of browsing sessions, most recent first. Shows time, duration, domains, and keywords per session.

**Raw Events** — the 20 most recently captured events for quick inspection.

Below the Intent Map header: a password input for your Anthropic API key, a **Save key** button, and a **Label with AI** button.

## Tuning

All tunables are named constants — change the value, rebuild, and re-run the pipeline from the dashboard.

| Constant | Default | File | Effect |
|---|---|---|---|
| `SESSION_GAP_MS` | `30 min` | `src/pipeline/sessions.ts` | Minimum idle gap that starts a new session. Lower → more, shorter sessions. |
| `UBIQUITY_THRESHOLD` | `0.6` | `src/pipeline/ambient.ts` | Fraction of active days a domain must appear on to be considered ambient. Lower → more domains excluded from clustering. |
| `MIN_ACTIVE_DAYS` | `3` | `src/pipeline/ambient.ts` | Minimum active-day count before ubiquity is even computed. |
| `SIMILARITY_THRESHOLD` | `0.15` | `src/pipeline/threads.ts` | Jaccard threshold for merging sessions into the same thread. **Lower → more aggressive merging (fewer, bigger threads). Higher → more fragmentation (more, smaller threads).** |
| `BLOCKED_DOMAINS` | (list) | `src/pipeline/noise.ts` | Comms/utility domains dropped before sessionization. Add domains freely. |
| `ADULT_DOMAINS` / `JUNK_DOMAINS` | (lists) | `src/pipeline/noise.ts` | Separate lists merged at runtime; either is independently removable. |
| `PLATFORM_STOPWORDS` | (list) | `src/pipeline/keywords.ts` | Social-platform brand and UI tokens excluded from keyword extraction. |

## Project structure

```
openloops/
├── public/
│   └── openloops-logo.svg
├── src/
│   ├── background.ts          # service worker: install hook + live capture
│   ├── types.ts               # shared TypeScript interfaces
│   ├── db/
│   │   └── index.ts           # IndexedDB schema + all store helpers
│   ├── lib/
│   │   ├── settings.ts        # chrome.storage.local API-key helpers
│   │   └── util.ts            # isHttpUrl, extractDomain, hashId
│   ├── pipeline/
│   │   ├── backfill.ts        # history API backfill
│   │   ├── noise.ts           # domain blocklist + title filter
│   │   ├── keywords.ts        # keyword extraction + stopword lists
│   │   ├── sessions.ts        # gap-based segmentation
│   │   ├── ambient.ts         # ubiquity-based ambient domain detector
│   │   ├── threads.ts         # clustering + scoring
│   │   └── label.ts           # opt-in AI labeling (Claude Haiku 4.5)
│   └── dashboard/
│       ├── index.html
│       ├── main.tsx
│       ├── App.tsx            # React dashboard
│       └── app.css
├── manifest.json
├── vite.config.ts
├── tsconfig.json
├── CLAUDE.md                  # architecture notes for AI-assisted development
├── CONTRIBUTING.md
└── LICENSE
```

## Setup

**Prerequisites:** Node 18+, Chrome (or any Chromium-based browser).

```bash
git clone https://github.com/sholajegede/openloops.git
cd openloops
npm install
npm run build
```

Then in Chrome:
1. Go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `dist/` folder

There is **no `.env` file** and no environment variables. The optional Anthropic API key is pasted directly into the dashboard at runtime — it is stored in `chrome.storage.local` on your device and never touches the repository.

## Usage

1. Click the openloops toolbar icon (or navigate to the extension's options page) to open the dashboard.
2. **Scan my history** — backfills 14 days of browsing into IndexedDB.
3. **Build sessions** — segments events into sessions and extracts keywords.
4. **Build intent map** — clusters sessions into threads and scores them.
5. *(Optional)* Paste your Anthropic API key → **Save key** → **Label with AI** — rewrites thread titles and adds one-sentence summaries via Claude Haiku 4.5.

Run steps 2–4 again any time to rebuild from scratch with the latest browsing data.

## Tech

- **[TypeScript](https://www.typescriptlang.org/)** — strict types throughout
- **[Vite](https://vitejs.dev/) + [@crxjs/vite-plugin](https://crxjs.dev/vite-plugin)** — build and HMR for Manifest V3 extensions
- **[React 18](https://react.dev/)** — dashboard UI (full Chrome tab via `options_page`)
- **[idb](https://github.com/jakearchibald/idb)** — typed IndexedDB wrapper
- **[Claude Haiku 4.5](https://www.anthropic.com/)** — optional AI thread labeling (bring your own key)
- Chrome Extension **Manifest V3** — service worker, `history`/`tabs`/`storage` permissions

## Screenshot

> *Drop a screenshot or GIF of the dashboard here once it's ready.*

MIT License — see [LICENSE](./LICENSE).