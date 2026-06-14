import { extractDomain, hashId, isHttpUrl } from "../lib/util";
import { putEvents, clearEvents } from "../db/index";
import type { RawEvent } from "../types";

// How many chrome.history.getVisits calls to fire concurrently.
// Chrome doesn't document a hard limit, but flooding it with thousands of
// simultaneous calls can cause jank; 50 in-flight at a time is a safe middle ground.
const CONCURRENCY = 50;

/**
 * Fetch individual visit records for a single HistoryItem and map them to
 * RawEvents whose visitedAt falls within [startTime, now].
 */
async function visitsForItem(
  item: chrome.history.HistoryItem,
  startTime: number
): Promise<RawEvent[]> {
  // Skip items with no URL (Chrome can return these for deleted history)
  if (!item.url) return [];
  // Skip non-web URLs (chrome-extension://, chrome://, about:, file://, etc.)
  if (!isHttpUrl(item.url)) return [];

  const visits = await chrome.history.getVisits({ url: item.url });

  const events: RawEvent[] = [];
  for (const visit of visits) {
    // getVisits returns ALL history for a URL, not just the window — filter here.
    if (!visit.visitTime || visit.visitTime < startTime) continue;

    events.push({
      id: hashId(item.url, visit.visitTime),
      url: item.url,
      domain: extractDomain(item.url),
      title: item.title ?? item.url,
      visitedAt: visit.visitTime,
      source: "backfill",
    });
  }

  return events;
}

/**
 * Backfill the user's browsing history for the last `days` days into IndexedDB.
 *
 * Why search + getVisits instead of search alone?
 * chrome.history.search returns one record per URL — the most recent visit.
 * We need one record per *visit* so that session grouping (Phase 2) can work
 * correctly. getVisits gives us the full timestamp list for each URL.
 *
 * @returns Number of RawEvents written.
 */
export async function backfillHistory(days = 14): Promise<number> {
  // Wipe the store first so each scan is a clean 14-day snapshot.
  // Every real visit exists in chrome.history, so nothing of value is lost.
  await clearEvents();

  const startTime = Date.now() - days * 24 * 60 * 60 * 1000;

  // Step 1: get all unique URLs visited since startTime.
  // maxResults default is 100 — far too low for real browsing; use a high cap.
  const historyItems = await chrome.history.search({
    text: "",
    startTime,
    maxResults: 100_000,
  });

  // Step 2: fan out to getVisits with bounded concurrency.
  let totalWritten = 0;

  for (let i = 0; i < historyItems.length; i += CONCURRENCY) {
    const batch = historyItems.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((item) => visitsForItem(item, startTime))
    );
    const events = batchResults.flat();
    await putEvents(events);
    totalWritten += events.length;
  }

  return totalWritten;
}
