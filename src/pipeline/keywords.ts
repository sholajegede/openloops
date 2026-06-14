/**
 * Light keyword extraction for session labeling.
 * Not NLP — just frequency counting after stopword removal.
 * Good enough to surface "typescript generics" or "react hooks" from a session
 * of related browsing, which is all we need for thread clustering.
 */

import { BLOCKED_DOMAINS } from "./noise";

// ---------------------------------------------------------------------------
// Stop-token sets
// ---------------------------------------------------------------------------

/**
 * Common English function words plus generic UI/site-chrome tokens that appear
 * in page titles but carry no topical meaning.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  // common English function words
  "the", "and", "for", "with", "you", "your", "how", "what", "this", "that",
  "from", "are", "was", "not", "but", "all", "can", "has", "have", "will",
  "its", "out", "one", "get", "our", "had", "just", "about", "also", "more",
  "into", "than", "then", "when", "their", "there", "which", "would", "been",
  "his", "her", "who", "they", "she", "him", "now", "any", "way", "use",
  "using", "used", "make", "made",
  // site / UI noise
  "google", "youtube", "search", "chat", "new", "home", "www", "com", "org",
  "net", "page", "site", "tab", "view", "app", "log", "sign", "login",
  "official", "free", "online", "best", "top", "open",
]);

/**
 * Platform and social-media tokens that pollute keyword extraction the same way
 * their domains pollute the event stream. A title like "Reels · Instagram" or
 * "Watch - YouTube" should produce no keywords at all; without this list it
 * would produce ["reels", "instagram"] or ["watch"] which become thread titles
 * and contaminate clustering similarity scores.
 *
 * Platform/brand tokens are topical noise in exactly the same way the
 * BLOCKED_DOMAINS list is: they identify the tool being used, not the intent
 * behind the browsing.
 */
export const PLATFORM_STOPWORDS: ReadonlySet<string> = new Set([
  // platforms & brands
  "instagram", "facebook", "youtube", "claude", "google", "linkedin",
  "twitter", "reddit", "netflix", "amazon", "gmail", "whatsapp", "tiktok",
  "messenger",
  // social content / UI chrome
  "stories", "story", "reel", "reels", "shorts", "short", "feed", "watch",
  "video", "videos", "music", "post", "posts", "message", "messages",
  "dm", "dms", "notification", "notifications", "profile", "home", "login",
  "signin", "follow", "followers",
]);

/**
 * Automatically derive the second-level domain label from each entry in
 * BLOCKED_DOMAINS and add it to the stop-token set, so the two lists stay in
 * sync without manual updates.
 *
 * Examples:
 *   "mail.google.com"   → "google"
 *   "web.whatsapp.com"  → "whatsapp"
 *   "app.slack.com"     → "slack"
 *   "messenger.com"     → "messenger"
 *
 * This means adding a new domain to BLOCKED_DOMAINS automatically prevents its
 * brand name from polluting keyword extraction.
 */
function derivedDomainLabels(): Set<string> {
  const labels = new Set<string>();
  for (const domain of BLOCKED_DOMAINS) {
    // Second-level domain = the label immediately before the TLD.
    const label = domain.split(".").at(-2);
    if (label) labels.add(label);
  }
  return labels;
}

/**
 * The combined stop-token set used during extraction.
 * Merges STOPWORDS + PLATFORM_STOPWORDS + labels derived from BLOCKED_DOMAINS.
 * Built once at module load; cheap to check at runtime.
 */
const ALL_STOP_TOKENS: ReadonlySet<string> = new Set([
  ...STOPWORDS,
  ...PLATFORM_STOPWORDS,
  ...derivedDomainLabels(),
]);

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Given an array of page titles (one per event in a session), return the top
 * `max` meaningful tokens ranked by frequency across all titles.
 *
 * Steps:
 *   1. Flatten all titles, lowercase, split on non-alphanumeric characters.
 *   2. Drop tokens shorter than 3 characters (nearly always noise or articles).
 *   3. Drop pure numbers (counts, years, IDs).
 *   4. Drop ALL_STOP_TOKENS (English function words, platform brands, UI chrome).
 *   5. Count frequency, return top `max` by count.
 */
export function extractKeywords(titles: string[], max = 8): string[] {
  const freq = new Map<string, number>();

  for (const title of titles) {
    const tokens = title.toLowerCase().split(/[^a-z0-9]+/);
    for (const token of tokens) {
      if (token.length < 3) continue;
      if (/^\d+$/.test(token)) continue;
      if (ALL_STOP_TOKENS.has(token)) continue;

      freq.set(token, (freq.get(token) ?? 0) + 1);
    }
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([token]) => token);
}
