/**
 * Extract the registrable domain from a URL for display and grouping.
 *
 * NOTE: This strips only a leading "www." and returns the raw hostname.
 * That's a simplification — "bbc.co.uk" and "news.bbc.co.uk" would not
 * be collapsed correctly. True registrable-domain extraction requires the
 * Public Suffix List (https://publicsuffix.org/). Deferred as a future
 * improvement; acceptable for a tutorial MVP.
 */
/** True only for http:// and https:// URLs — the shared scheme guard used by
 *  both live capture (background.ts) and backfill so the definition never drifts. */
export function isHttpUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

export function extractDomain(url: string): string {
  try {
    const { hostname } = new URL(url);
    return hostname.replace(/^www\./, "");
  } catch {
    // Malformed URLs (e.g. chrome-extension://, about:blank) return as-is.
    return url;
  }
}

/**
 * Produce a short, deterministic ID for a (url, visitedAt) pair using a
 * djb2-style hash. Running backfill twice for the same visit produces the
 * same ID, so putEvents (which uses IDB's "put" not "add") overwrites rather
 * than duplicates.
 */
export function hashId(url: string, visitedAt: number): string {
  const str = `${url}|${visitedAt}`;
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    // djb2: hash * 33 XOR char code, kept 32-bit signed
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash |= 0;
  }
  // Shift to unsigned then encode as base-36 for a compact alphanumeric string
  return (hash >>> 0).toString(36);
}
