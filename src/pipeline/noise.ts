import type { RawEvent } from "../types";
import { isHttpUrl } from "../lib/util";

// ---------------------------------------------------------------------------
// Filter 1: static utility / comms domain blocklist
// ---------------------------------------------------------------------------

/**
 * Domains that are pure communication or productivity tools and carry no
 * research intent worth threading. We match exact domain AND any subdomain
 * (e.g. "slack.com" also catches "app.slack.com").
 *
 * NOTE: This is a curated static list. A complementary frequency-based detector
 * ("drop any domain that appears in >X% of all events") runs in the clustering
 * phase (src/pipeline/ambient.ts) where global event statistics are available.
 */
export const BLOCKED_DOMAINS: readonly string[] = [
  "mail.google.com",
  "outlook.live.com",
  "outlook.office.com",
  "calendar.google.com",
  "slack.com",
  "app.slack.com",
  "discord.com",
  "web.whatsapp.com",
  "teams.microsoft.com",
  "messenger.com",
];

// ---------------------------------------------------------------------------
// Filter 2: adult content domains
// ---------------------------------------------------------------------------

/**
 * Adult content domains dropped before sessionization.
 * Real products need a proper content-category filtering layer; this list keeps
 * the project's content clean without building that full layer.
 * Kept as its own constant so it is easy to extend or remove entirely.
 */
export const ADULT_DOMAINS: readonly string[] = [
  "xvideos.com",
  "pornhub.com",
  "xnxx.com",
  "xhamster.com",
  "redtube.com",
  "youporn.com",
  "spankbang.com",
];

// ---------------------------------------------------------------------------
// Filter 3: tracker / redirect junk domains
// ---------------------------------------------------------------------------

/**
 * Known tracker, redirect, and junk domains that appear as raw events but
 * represent infrastructure noise rather than intentional page visits.
 * Kept as its own constant so it is easy to extend or remove entirely.
 */
export const JUNK_DOMAINS: readonly string[] = [
  "trk.myperfect2give.com",
  "t.buenotraffic.com",
  "bwredir.com",
  "osom.saintscommunity.net",
];

/** Combined set of all blocked domains for O(1) lookup. */
const ALL_BLOCKED = [...BLOCKED_DOMAINS, ...ADULT_DOMAINS, ...JUNK_DOMAINS];

function domainIsBlocked(domain: string): boolean {
  return ALL_BLOCKED.some(
    (blocked) => domain === blocked || domain.endsWith("." + blocked)
  );
}

// ---------------------------------------------------------------------------
// Filter 4: generic / navigational title filter
// ---------------------------------------------------------------------------

/**
 * Title prefixes (lowercased) that signal a navigational or browser-chrome page
 * rather than a content page. We drop by prefix so that "New chat - Claude",
 * "New Tab", "Loading...", "Dashboard | Vercel" etc. are all caught by a
 * single entry. Content-rich titles on the same domain pass through.
 */
export const NOISE_TITLE_PREFIXES: readonly string[] = [
  "new tab",
  "new chat",
  "untitled",
  "inbox",
  "home",
  "dashboard",
  "sign in",
  "log in",
  "loading",
];

function titleIsGeneric(title: string, domain: string): boolean {
  if (title.trim() === "") return true;
  if (title.toLowerCase() === domain.toLowerCase()) return true;

  const lower = title.toLowerCase();
  return NOISE_TITLE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true if this event should be dropped before session segmentation.
 * A noise event is one that matches the domain blocklist (comms tools, adult
 * content, or tracker junk) or has a generic/navigational title.
 */
export function isNoise(event: RawEvent): boolean {
  // Belt-and-suspenders: drop non-web URLs even if they somehow reached the store.
  if (!isHttpUrl(event.url)) return true;
  return domainIsBlocked(event.domain) || titleIsGeneric(event.title, event.domain);
}
