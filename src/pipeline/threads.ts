/**
 * Intent thread clustering and scoring — Phase 4.
 *
 * OVERVIEW
 * ────────
 * We use greedy agglomerative clustering: process sessions chronologically,
 * and for each session try to merge it into the most similar existing thread.
 * If no thread is similar enough, seed a new one.
 *
 * After clustering, each thread is scored and classified into a human-readable
 * IntentThread with type, confidence, status, and plain-English signals.
 *
 * WORKED EXAMPLE (3 sessions, SIMILARITY_THRESHOLD = 0.3)
 * ────────────────────────────────────────────────────────
 * Ambient domains detected: { youtube.com } (appears every day)
 *
 * S1: domains=[stackoverflow.com, typescriptlang.org]
 *     keywords=[typescript, generics, interface, mapped]
 *
 * S2: domains=[stackoverflow.com, typescriptlang.org, github.com]
 *     keywords=[typescript, generics, utility, types]
 *
 * S3: domains=[python.org, docs.python.org]
 *     keywords=[python, async, await, coroutine]
 *
 * Pass S1 → no threads yet → seed Thread A
 *   Thread A: domains={stackoverflow.com, typescriptlang.org}
 *             keywords={typescript, generics, interface, mapped}
 *
 * Pass S2 → score against Thread A:
 *   Non-ambient domains S2: {stackoverflow.com, typescriptlang.org, github.com}
 *   Non-ambient domains TA: {stackoverflow.com, typescriptlang.org}
 *   domainJaccard = |{so, ts-lang}| / |{so, ts-lang, github}| = 2/3 ≈ 0.667
 *   keywordJaccard = |{typescript, generics}| / |{ts, gen, iface, mapped, util, types}| = 2/6 ≈ 0.333
 *   similarity = 0.5×0.667 + 0.5×0.333 = 0.50  ≥ 0.3 → MERGE into Thread A
 *   Thread A now: domains={so, ts-lang, github} keywords={ts, gen, iface, mapped, util, types}
 *
 * Pass S3 → score against Thread A:
 *   domainJaccard({python.org, docs.python.org} vs {so, ts-lang, github}) = 0/5 = 0
 *   keywordJaccard({python, async, await, coroutine} vs {ts, gen, …}) = 0/10 = 0
 *   similarity = 0  <  0.3 → seed Thread B
 *
 * Final threads: [Thread A (TypeScript research), Thread B (Python async)]
 */

import { getAllSessions, clearThreads, putThreads } from "../db/index";
import { detectAmbientDomains } from "./ambient";
import { hashId } from "../lib/util";
import type { Session, IntentThread } from "../types";

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/**
 * Minimum weighted Jaccard similarity for a session to merge into an
 * existing thread rather than seed a new one.
 *
 * Lower = more sessions merged into fewer, broader threads (risk: over-merging
 * unrelated topics). Higher = more, narrower threads (risk: fragmenting a
 * single intent across many threads). Start at 0.3 and tune by reading the
 * console.table output after building.
 */
export const SIMILARITY_THRESHOLD = 0.15;

/** Weight given to domain overlap vs keyword overlap in the similarity score. */
export const DOMAIN_WEIGHT = 0.5;
export const KEYWORD_WEIGHT = 0.5;

// ---------------------------------------------------------------------------
// Type / status classification constants
// ---------------------------------------------------------------------------

/**
 * Single words found anywhere in a page title that signal purchase intent.
 * Checked as whole-word tokens (not substring) to avoid false positives
 * (e.g. "review" should not match "overview").
 */
export const BUYING_WORDS: readonly string[] = [
  "vs", "versus", "alternative", "alternatives",
  "comparison", "pricing", "price", "review", "reviews", "best",
];

/**
 * Words / phrases in page titles that signal a learning intent.
 * Multi-word entries (containing a space) are matched as substrings.
 */
export const LEARNING_WORDS: readonly string[] = [
  "how to", "tutorial", "tutorials", "docs", "documentation",
  "guide", "learn", "example", "examples", "crash course", "introduction",
];

/** 48 hours — lastSeen within this range → "active". */
const STATUS_ACTIVE_MS  = 48 * 60 * 60 * 1000;
/** 7 days — lastSeen within this range → "stalled". */
const STATUS_STALLED_MS = 7  * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Internal thread builder type
// ---------------------------------------------------------------------------

/**
 * Mutable accumulator used during clustering.
 * Converted to the immutable IntentThread after all sessions are processed.
 */
interface ThreadBuilder {
  id: string;
  sessions: Session[];
  /** Union of all session domains — used for future similarity comparisons. */
  domainSet: Set<string>;
  /** Union of all session keywords — used for future similarity comparisons. */
  keywordSet: Set<string>;
}

// ---------------------------------------------------------------------------
// Step 1: Similarity helpers
// ---------------------------------------------------------------------------

/**
 * Jaccard similarity between two sets: |A ∩ B| / |A ∪ B|.
 * Returns 0 when both sets are empty (no overlap, not an error).
 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return intersection / union;
}

/**
 * Weighted similarity between a candidate session and an existing thread.
 * Ambient domains are excluded before scoring so they don't create false
 * similarity between unrelated sessions that happen to share a daily-use tool.
 */
function similarity(
  session: Session,
  thread: ThreadBuilder,
  ambient: Set<string>
): number {
  const sessionDomains  = new Set(session.domains.filter((d) => !ambient.has(d)));
  const threadDomains   = new Set([...thread.domainSet].filter((d) => !ambient.has(d)));
  const sessionKeywords = new Set(session.keywords);

  const domainScore   = jaccard(sessionDomains, threadDomains);
  const keywordScore  = jaccard(sessionKeywords, thread.keywordSet);

  return DOMAIN_WEIGHT * domainScore + KEYWORD_WEIGHT * keywordScore;
}

// ---------------------------------------------------------------------------
// Step 2: Greedy clustering
// ---------------------------------------------------------------------------

function clusterSessions(
  sessions: Session[],
  ambient: Set<string>
): ThreadBuilder[] {
  const threads: ThreadBuilder[] = [];

  for (const session of sessions) {
    let bestThread: ThreadBuilder | null = null;
    let bestScore = 0;

    // Score this session against every existing thread.
    for (const thread of threads) {
      const score = similarity(session, thread, ambient);
      if (score > bestScore) {
        bestScore = score;
        bestThread = thread;
      }
    }

    if (bestThread && bestScore >= SIMILARITY_THRESHOLD) {
      // Merge: add the session and expand the accumulated sets.
      bestThread.sessions.push(session);
      for (const d of session.domains)  bestThread.domainSet.add(d);
      for (const k of session.keywords) bestThread.keywordSet.add(k);
    } else {
      // Seed: this session starts a brand-new thread.
      threads.push({
        id: hashId(session.id, session.startedAt),
        sessions: [session],
        domainSet:  new Set(session.domains),
        keywordSet: new Set(session.keywords),
      });
    }
  }

  return threads;
}

// ---------------------------------------------------------------------------
// Step 3: Scoring & classification
// ---------------------------------------------------------------------------

function toTitleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Scan an array of raw page titles for any entry from a word list.
 * Multi-word entries (containing " ") are tested as substrings.
 * Single words are tested as whole tokens (split on non-alphanumeric).
 */
function findMatches(titles: string[], wordList: readonly string[]): string[] {
  const lower = titles.map((t) => t.toLowerCase());
  const found = new Set<string>();

  for (const word of wordList) {
    const isPhrase = word.includes(" ");
    for (const title of lower) {
      if (isPhrase) {
        if (title.includes(word)) found.add(word);
      } else {
        // Whole-word match: split title into tokens and check membership.
        const tokens = title.split(/[^a-z0-9]+/);
        if (tokens.includes(word)) found.add(word);
      }
    }
  }

  return [...found];
}

function toCalendarDay(epochMs: number): string {
  return new Date(epochMs).toDateString();
}

/**
 * Convert a ThreadBuilder (mutable clustering accumulator) into the final
 * scored and classified IntentThread that gets stored in IndexedDB.
 */
function scoreThread(builder: ThreadBuilder): IntentThread {
  const { sessions, keywordSet } = builder;

  // ── Time bounds ──────────────────────────────────────────────────────────
  const firstSeen  = sessions[0].startedAt;
  const lastSeen   = sessions[sessions.length - 1].endedAt;

  // ── Distinct days ─────────────────────────────────────────────────────────
  const allEvents  = sessions.flatMap((s) => s.events);
  const totalEvents = allEvents.length;
  const daySet     = new Set(allEvents.map((e) => toCalendarDay(e.visitedAt)));
  const distinctDays = daySet.size;

  // ── Classification ────────────────────────────────────────────────────────
  const allTitles      = allEvents.map((e) => e.title);
  const buyingMatches  = findMatches(allTitles, BUYING_WORDS);
  const learningMatches = findMatches(allTitles, LEARNING_WORDS);

  let type: IntentThread["type"];
  if (buyingMatches.length > 0) {
    type = "buying";
  } else if (learningMatches.length > 0) {
    type = "learning";
  } else if (distinctDays > 5 && sessions.length >= 3) {
    // Revisited across many days with multiple sessions → sustained planning.
    type = "planning";
  } else if (totalEvents >= 3) {
    type = "research";
  } else {
    type = "unclassified";
  }

  // ── Status from recency ───────────────────────────────────────────────────
  const age = Date.now() - lastSeen;
  const status: IntentThread["status"] =
    age < STATUS_ACTIVE_MS  ? "active"  :
    age < STATUS_STALLED_MS ? "stalled" :
    "dormant";

  // ── Confidence ────────────────────────────────────────────────────────────
  // Weighted sum of four normalized signals, each contributing to 1.0 total.
  const confidence = parseFloat((
    Math.min(distinctDays / 5, 1) * 0.35 +   // 5 distinct days = full weight
    Math.min(sessions.length / 5, 1) * 0.25 + // 5 sessions = full weight
    Math.min(totalEvents / 20, 1)  * 0.20 +   // 20 events = full weight
    (type !== "unclassified" ? 1 : 0)  * 0.20 // clear type = full weight
  ).toFixed(2));

  // ── Human-readable signals ────────────────────────────────────────────────
  const signals: string[] = [];

  if (distinctDays > 1)
    signals.push(`revisited across ${distinctDays} days`);
  if (type === "buying" && buyingMatches.length > 0)
    signals.push(`comparison language: ${buyingMatches.join(", ")}`);
  if (type === "learning" && learningMatches.length > 0)
    signals.push(`learning language: ${learningMatches.join(", ")}`);
  signals.push(`${sessions.length} session${sessions.length !== 1 ? "s" : ""}`);
  if (totalEvents > 5)
    signals.push(`${totalEvents} total events`);
  if (type === "planning")
    signals.push("sustained activity across many days");

  const ageDays = Math.floor(age / (24 * 60 * 60 * 1000));
  if (ageDays === 0)       signals.push("last active today");
  else if (ageDays === 1)  signals.push("last active yesterday");
  else                     signals.push(`last active ${ageDays} days ago`);

  // ── Heuristic title from top keywords ─────────────────────────────────────
  // Phase 6 will replace this with an AI-generated name.
  const title =
    [...keywordSet].slice(0, 3).map(toTitleCase).join(" ") || "Untitled Thread";

  return {
    id: builder.id,
    title,
    sessions,
    type,
    confidence,
    status,
    firstSeen,
    lastSeen,
    distinctDays,
    signals,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read all sessions from IndexedDB, run ambient detection → clustering →
 * scoring, then persist the result. Safe to call multiple times: clearThreads
 * wipes the store before writing.
 *
 * @returns counts of sessions processed and threads written.
 */
export async function buildThreads(): Promise<{ sessions: number; threads: number }> {
  const sessions = await getAllSessions();

  if (sessions.length === 0) {
    await clearThreads();
    return { sessions: 0, threads: 0 };
  }

  // Step 1: detect ambient domains to exclude from similarity scoring.
  const ambient = detectAmbientDomains(sessions);

  // Step 2: greedy clustering — sessions are already in ascending startedAt
  // order from getAllSessions(), which is the order we need.
  const builders = clusterSessions(sessions, ambient);

  // Step 3: prune threads that are clearly one-off noise (1 session, < 3 events).
  const substantive = builders.filter(
    (b) => !(b.sessions.length === 1 && b.sessions[0].events.length < 3)
  );

  // Step 4: score and classify each surviving thread.
  const threads = substantive.map(scoreThread);

  // Step 5: persist.
  await clearThreads();
  await putThreads(threads);

  // Eyeball table — helps tune SIMILARITY_THRESHOLD without opening DevTools.
  // Each row shows the key signals; look for threads that should be merged
  // (same topic, low similarity forced separate threads) or split (unrelated
  // sessions lumped together because they shared an ambient domain).
  console.table(
    threads.map((t) => ({
      title:        t.title,
      type:         t.type,
      status:       t.status,
      confidence:   t.confidence,
      distinctDays: t.distinctDays,
      sessions:     t.sessions.length,
      events:       t.sessions.reduce((n, s) => n + s.events.length, 0),
      keywords:     [...new Set(t.sessions.flatMap((s) => s.keywords))].slice(0, 5).join(", "),
    }))
  );

  return { sessions: sessions.length, threads: threads.length };
}
