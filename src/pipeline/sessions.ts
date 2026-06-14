/**
 * Session segmentation — Phase 3.
 *
 * A "session" is a contiguous block of browsing activity. We define a boundary
 * whenever the gap between two consecutive events exceeds SESSION_GAP_MS.
 *
 * Worked example
 * ──────────────
 * Input events (after noise filtering, ascending by visitedAt):
 *
 *   A  t= 0 min  "TypeScript generics - Stack Overflow"   stackoverflow.com
 *   B  t= 5 min  "TypeScript Handbook"                    typescriptlang.org
 *   C  t=10 min  "microsoft/TypeScript - GitHub"          github.com
 *      ↑ gap to D = 45 min  >  SESSION_GAP_MS (30 min)  → SPLIT HERE
 *   D  t=55 min  "React hooks tutorial - YouTube"         youtube.com
 *   E  t=60 min  "useEffect cleanup - Stack Overflow"     stackoverflow.com
 *
 * Output sessions:
 *   Session 1: [A, B, C]  startedAt=t0  endedAt=t10  keywords=[typescript, generics, handbook]
 *   Session 2: [D, E]     startedAt=t55 endedAt=t60  keywords=[react, hooks, useeffect, cleanup]
 */

import { getAllEvents, clearSessions, putSessions } from "../db/index";
import { isNoise } from "./noise";
import { extractKeywords } from "./keywords";
import { hashId } from "../lib/util";
import type { RawEvent, Session } from "../types";

/**
 * The maximum idle gap (ms) that is still considered the same browsing session.
 * 30 minutes is the de-facto industry standard (used by Google Analytics, etc.)
 * and works well for most browsing patterns.
 *
 * Tradeoff: shorter = more, smaller sessions (more granular intent signal but
 * more fragmentation); longer = fewer, larger sessions (may merge unrelated
 * activity). Making this user-configurable is a natural future improvement.
 */
const SESSION_GAP_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Count how many events came from each domain in this session and return the
 * domain names ordered by descending frequency (most-visited domain first).
 */
function rankDomains(events: RawEvent[]): string[] {
  const freq = new Map<string, number>();
  for (const e of events) {
    freq.set(e.domain, (freq.get(e.domain) ?? 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([domain]) => domain);
}

/** Build a Session object from a completed group of events. */
function buildSession(events: RawEvent[]): Session {
  const startedAt = events[0].visitedAt;
  const endedAt = events[events.length - 1].visitedAt;

  return {
    id: hashId(events[0].url, startedAt),
    events,
    startedAt,
    endedAt,
    domains: rankDomains(events),
    keywords: extractKeywords(events.map((e) => e.title)),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read all raw events, filter noise, walk the sorted list to group events into
 * sessions, then persist the result. Calling this multiple times is safe:
 * clearSessions() wipes the store before writing.
 *
 * @returns counts of events processed and sessions written.
 */
export async function buildSessions(): Promise<{ events: number; sessions: number }> {
  // Step 1: load all raw events sorted by visitedAt ascending.
  const allEvents = await getAllEvents();

  // Step 2: remove noise — utility tools and generic navigational pages.
  const meaningful = allEvents.filter((e) => !isNoise(e));

  if (meaningful.length === 0) {
    await clearSessions();
    return { events: 0, sessions: 0 };
  }

  // Step 3: walk the list and split on gaps > SESSION_GAP_MS.
  const sessions: Session[] = [];
  let currentGroup: RawEvent[] = [meaningful[0]];

  for (let i = 1; i < meaningful.length; i++) {
    const gap = meaningful[i].visitedAt - meaningful[i - 1].visitedAt;

    if (gap > SESSION_GAP_MS) {
      // Gap is too large — close the current session and start a new one.
      sessions.push(buildSession(currentGroup));
      currentGroup = [meaningful[i]];
    } else {
      currentGroup.push(meaningful[i]);
    }
  }
  // Don't forget the final in-progress group.
  sessions.push(buildSession(currentGroup));

  // Step 4: drop trivial sessions — a single event with no extractable keywords.
  // These are usually stray page loads that didn't fit anywhere meaningful.
  const substantive = sessions.filter(
    (s) => !(s.events.length === 1 && s.keywords.length === 0)
  );

  // Step 5: persist (clear first so rebuilds don't leave stale records).
  await clearSessions();
  await putSessions(substantive);

  return { events: meaningful.length, sessions: substantive.length };
}
