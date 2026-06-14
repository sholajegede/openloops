import { hashId, extractDomain, isHttpUrl } from "./lib/util";
import { putEvents } from "./db/index";
import type { RawEvent } from "./types";

// ---------------------------------------------------------------------------
// Install / startup
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  console.log("[openloops] Extension installed.");
});

// Open the dashboard as a full Chrome tab when the toolbar icon is clicked.
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

// ---------------------------------------------------------------------------
// Live capture — tabs.onUpdated
// ---------------------------------------------------------------------------

// Best-effort in-memory dedup guard.
//
// SPA frameworks and some sites fire tabs.onUpdated "complete" multiple times
// for what is logically one page load. We skip a tab if it reports "complete"
// for the same URL within DEDUP_MS milliseconds of the last capture.
//
// IMPORTANT: the service worker can be suspended between events and this Map
// is lost when that happens, so the guard is best-effort only. It prevents
// duplicate bursts within a single waking session, not across SW restarts.
const DEDUP_MS = 3_000;
const recentCaptures = new Map<number, { url: string; at: number }>();

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // We only act once the page has fully loaded and has a URL.
  if (changeInfo.status !== "complete" || !tab.url) return;

  const url = tab.url;

  // Skip browser internals, extension pages, local files, and any non-web scheme.
  if (!isHttpUrl(url)) return;

  // Dedup check: same tab, same URL, fired within DEDUP_MS → skip.
  const last = recentCaptures.get(tabId);
  const now = Date.now();
  if (last && last.url === url && now - last.at < DEDUP_MS) {
    console.log(`[openloops] dedup skip — tab ${tabId} ${url}`);
    return;
  }

  recentCaptures.set(tabId, { url, at: now });

  const event: RawEvent = {
    id: hashId(url, now),
    url,
    domain: extractDomain(url),
    title: tab.title ?? url,
    visitedAt: now,
    source: "live",
  };

  // putEvents is async; fire-and-forget is fine here — the SW will stay alive
  // long enough to complete a single IDB write.
  putEvents([event]).then(() => {
    console.log(`[openloops] captured ${event.domain} — ${event.title}`);
  }).catch((err) => {
    console.error("[openloops] putEvents failed:", err);
  });
});
