# openloops — Chrome Extension

A local-only extension that reconstructs browsing history into "intent threads."
Built as a freeCodeCamp tutorial — code clarity matters as much as correctness.

**Rename note:** The product was renamed from "Signal" to "openloops". The
IndexedDB name changed from `"signal"` to `"openloops"` (DB_VERSION still 3).
Users must re-run Scan once after updating to populate the new database.
New files added: `public/openloops-logo.svg`, `README.md`, `LICENSE`,
`CONTRIBUTING.md`.

## Stack

- Chrome extension, Manifest V3
- TypeScript everywhere
- Vite + `@crxjs/vite-plugin` for build and HMR
- React 18 for the dashboard (full extension tab, not a popup)
- IndexedDB via the `idb` library for all storage
- Plain CSS, no UI framework
- Permissions: `history`, `tabs`, `storage`

## Architecture

Local-only pipeline, no backend, no accounts, no sync:

```
chrome.history (backfill)
tabs.onUpdated (live)
        |
        v
   raw_events  (IndexedDB)
        |
        v
    sessions   (IndexedDB)
        |
        v
intent_threads (IndexedDB)
        |
        v
  React dashboard
```

Each stage is a separate IndexedDB object store and is independently inspectable.

## Folder Structure

```
src/
  pipeline/   # one module per pipeline stage
  db/         # IndexedDB setup and store helpers
  dashboard/  # React app entry point and components
  types.ts    # shared TypeScript interfaces
```

## Data Model (`src/types.ts`)

```ts
interface RawEvent {
  id: string;
  url: string;
  domain: string;
  title: string;
  visitedAt: number;        // epoch ms
  source: "backfill" | "live";
}

interface Session {
  id: string;
  events: RawEvent[];
  startedAt: number;
  endedAt: number;
  domains: string[];
  keywords: string[];
}

interface IntentThread {
  id: string;
  title: string;
  sessions: Session[];
  type: "buying" | "research" | "planning" | "learning" | "unclassified";
  confidence: number;       // 0-1
  status: "active" | "stalled" | "dormant";
  firstSeen: number;
  lastSeen: number;
  distinctDays: number;
  signals: string[];
}
```

## Conventions

- Each pipeline stage lives in its own file under `src/pipeline/`.
- No premature abstraction. Favor readable, well-commented functions a learner can follow.
- Build in phases; do not implement future phases early.

## Build & Load

```bash
npm run build          # production build -> dist/
npm run dev            # watch mode with HMR (CRXJS reloads the extension)
```

Load the extension: Chrome → `chrome://extensions` → Developer mode ON → "Load unpacked" → select `dist/`.

## Phases

- [x] Phase 0 — Scaffold (manifest, service worker stub, dashboard placeholder)
- [x] Phase 1 — Raw event ingestion (backfill only)
- [x] Phase 2 — Live capture (tabs.onUpdated)
- [x] Phase 3 — Noise filtering + session segmentation
- [x] Phase 4 — Intent threads (clustering + scoring)
- [ ] Phase 5 — Dashboard polish
- [x] Phase 6 — Optional AI labeling
- [x] Rename Signal → openloops + publication docs (README, LICENSE, CONTRIBUTING, logo)

## Phase 4 notes

**intent_threads store** — keyPath `id`, index `by_lastSeen`. DB bumped to version 3.

**Ambient detector** (`src/pipeline/ambient.ts`) — computes ubiquity per domain
(distinct days present / total active days). Domains with ubiquity ≥ 0.6 on ≥ 3
active days are excluded from similarity scoring so daily-use tools don't create
spurious thread connections. `UBIQUITY_THRESHOLD = 0.6`, `MIN_ACTIVE_DAYS = 3`.

**Clustering** (`src/pipeline/threads.ts`) — greedy agglomerative, sessions processed
chronologically. Similarity = `0.5 × domainJaccard + 0.5 × keywordJaccard` over
non-ambient domains. `SIMILARITY_THRESHOLD = 0.15`. Post-clustering, threads with
1 session and < 3 events are pruned. Primary tuning knob: `SIMILARITY_THRESHOLD` —
lower merges more aggressively, higher fragments more. Read the `console.table` to
spot mis-clustered threads.

**Scoring** — four weighted confidence signals (distinctDays 35%, sessions 25%,
events 20%, clear type 20%). Type from raw title scanning: `BUYING_WORDS` (whole-
word tokens) and `LEARNING_WORDS` (phrases via includes). Status: active < 48h,
stalled < 7d, dormant older. Signals array provides human-readable explanations.
Thread title is top-3 keywords title-cased (placeholder; Phase 6 replaces with AI).

**Phase 4 refinement — platform stopwords + adult/junk domains**

`PLATFORM_STOPWORDS` added to `keywords.ts`: social platform brands (instagram,
facebook, claude, linkedin, reddit, etc.) and social-UI chrome (stories, reels,
feed, watch, video, etc.) are now stripped before keyword extraction. Rationale:
these tokens are topical noise in exactly the same way the domain blocklist is —
they identify the platform, not the intent. `ALL_STOP_TOKENS` is the merged set
used at runtime (STOPWORDS + PLATFORM_STOPWORDS + labels auto-derived from
BLOCKED_DOMAINS via second-level domain extraction). Adding a domain to
BLOCKED_DOMAINS now automatically prevents its brand label from appearing as a keyword.

`ADULT_DOMAINS` and `JUNK_DOMAINS` added to `noise.ts` as two clearly-labeled
exported constants merged into `ALL_BLOCKED` for the domain check. Adult domains
kept separate from tracker junk so either list is removable independently.
`SIMILARITY_THRESHOLD` unchanged at 0.15 — re-evaluate after observing clusters
with clean keywords.

**Bugfix — backfill scheme filter + clean-snapshot behaviour**

`isHttpUrl(url)` added to `src/lib/util.ts` as the single shared definition of
"is this a real web page." `background.ts` now imports it instead of its local
copy, so the two entry points can never drift. `backfillHistory` calls
`clearEvents()` before scanning so each run produces a clean 14-day snapshot
(removes stale events and any previously-stored non-web URLs). `visitsForItem`
skips any URL that fails `isHttpUrl`, so `chrome-extension://`, `chrome://`,
`about:`, `file://`, etc. never enter `raw_events`. `isNoise` has a matching
belt-and-suspenders guard so non-web URLs are also dropped at the sessionization
boundary even if they somehow reach the store.

## Phase 3 notes

**sessions store** — keyPath `id`, index `by_startedAt`. DB bumped to version 2.
The upgrade callback guards each store with `objectStoreNames.contains()` so
existing v1 users get the new store without touching raw_events.

**Noise filter** (`src/pipeline/noise.ts`) — two independent checks, both
exported as named constants so extending them is a one-liner:
- `BLOCKED_DOMAINS`: static list of utility/comms domains. Matched by exact
  domain or suffix (`domain.endsWith("." + blocked)`) to catch subdomains.
- `NOISE_TITLE_PREFIXES`: navigational prefix list (case-insensitive).
  Catches "New chat - Claude", "Dashboard | Vercel", "Loading…" etc.
  A complementary frequency-based ambient-domain detector is deferred to
  the clustering phase.

**Keyword extraction** (`src/pipeline/keywords.ts`) — lowercase + split on
non-alphanumeric, drop tokens < 3 chars or pure numbers, remove `STOPWORDS`
(English function words + site-chrome noise), return top-N by frequency.

**Session segmentation** (`src/pipeline/sessions.ts`) — `SESSION_GAP_MS = 30 min`.
Gap is measured between consecutive events (ascending visitedAt). Trivial
sessions (1 event, 0 keywords) are dropped. `clearSessions()` before
`putSessions()` makes rebuilds idempotent.

## Phase 2 notes

**Live capture** — `chrome.tabs.onUpdated` in the service worker fires for every
tab event. We only act when `changeInfo.status === "complete"` and `tab.url` is
present. URL scheme is checked with `isHttpPage()`; `chrome://`, `chrome-extension://`,
`about:`, `file://`, `edge://`, and all other non-web schemes are silently skipped.

**Dedup guard** — a `Map<tabId, { url, at }>` suppresses duplicate "complete"
events for the same tab+URL within 3 s (DEDUP_MS). Best-effort only: the Map
lives in SW memory and is lost when Chrome suspends the service worker.

**Source field** — live-captured events carry `source: "live"` in the raw_events
store, distinguishing them from backfill records.

## Phase 1 notes

**raw_events store** — keyPath `id`, index `by_visitedAt`. DB version 1.
All migration logic is in the `upgrade` callback in `src/db/index.ts`; future
phases bump `DB_VERSION` and add stores there.

**Backfill approach** — `chrome.history.search` (text "", startTime, maxResults 100 000)
gives unique URLs. For each URL, `chrome.history.getVisits` is called to get
individual visit timestamps. This is necessary because search returns only the
*last* visit time per URL; per-visit records are needed for session grouping.
Visits are processed in batches of 50 (CONCURRENCY constant) to avoid flooding
the Chrome API.

**ID stability** — `hashId(url, visitTime)` produces a deterministic ID so
re-running backfill is idempotent (IDB `put` overwrites identical records).

**Domain extraction** — `extractDomain` strips `www.` only. True registrable-domain
extraction (e.g. collapsing `news.bbc.co.uk` → `bbc.co.uk`) requires the Public
Suffix List; deferred.
