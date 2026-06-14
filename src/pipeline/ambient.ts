import type { Session } from "../types";

/**
 * Ambient domain detection — Phase 4.
 *
 * An "ambient" domain is one you live in every day as a tool, not as a topic
 * you are researching. Examples: youtube.com (daily distraction), claude.ai
 * (daily chat tool), github.com for developers who commit every day.
 *
 * Ambient domains pollute the clustering step: if youtube.com appears in
 * 90% of sessions, every pair of sessions looks related because they all
 * share that one domain, producing one giant meaningless thread.
 *
 * We detect them by frequency: a domain is ambient if it appeared on at least
 * UBIQUITY_THRESHOLD of all days with any browsing activity.
 *
 * Tradeoff: this correctly removes genuinely ambient tools, but it can also
 * suppress a domain you happened to research intensively over many days
 * (e.g. researching a new framework every day for a week). UBIQUITY_THRESHOLD
 * is the primary tuning knob; raising it reduces false positives at the cost
 * of keeping some real ambient noise.
 */

/** Fraction of active days a domain must appear on to be considered ambient. */
export const UBIQUITY_THRESHOLD = 0.6;

/**
 * Minimum distinct active days required before the detector fires at all.
 * With only 1-2 days of data, almost every domain would be labelled ambient,
 * so we skip detection on small samples.
 */
export const MIN_ACTIVE_DAYS = 3;

/**
 * Helper: convert an epoch-ms timestamp to a calendar-day string
 * (e.g. "Sat Jun 14 2025"). Used to count distinct days without worrying
 * about time-zone drift within a session.
 */
function toDay(epochMs: number): string {
  return new Date(epochMs).toDateString();
}

/**
 * Inspect all sessions and return the set of domains whose ubiquity
 * (distinct days present / total active days) meets the threshold.
 *
 * @param sessions - the full list of sessions built in Phase 3.
 * @returns a Set of domain strings to exclude from similarity scoring.
 */
export function detectAmbientDomains(sessions: Session[]): Set<string> {
  const allEvents = sessions.flatMap((s) => s.events);

  // Count how many distinct calendar days had any browsing at all.
  const activeDays = new Set(allEvents.map((e) => toDay(e.visitedAt)));
  const totalActiveDays = activeDays.size;

  // Not enough data — skip detection to avoid mislabelling everything.
  if (totalActiveDays < MIN_ACTIVE_DAYS) {
    return new Set();
  }

  // For each domain, collect the distinct days it was visited.
  const domainDayMap = new Map<string, Set<string>>();
  for (const event of allEvents) {
    const day = toDay(event.visitedAt);
    if (!domainDayMap.has(event.domain)) {
      domainDayMap.set(event.domain, new Set());
    }
    domainDayMap.get(event.domain)!.add(day);
  }

  // A domain is ambient if it clears the ubiquity threshold.
  const ambient = new Set<string>();
  for (const [domain, days] of domainDayMap) {
    const ubiquity = days.size / totalActiveDays;
    if (ubiquity >= UBIQUITY_THRESHOLD) {
      ambient.add(domain);
      console.log(
        `[openloops] ambient: ${domain} (${days.size}/${totalActiveDays} days, ubiquity=${ubiquity.toFixed(2)})`
      );
    }
  }

  return ambient;
}
