/**
 * Extract the registrable domain from a URL for display and grouping.
 *
 * NOTE: This strips only a leading "www." and returns the raw hostname.
 * That's a simplification — "bbc.co.uk" and "news.bbc.co.uk" would not
 * be collapsed correctly. True registrable-domain extraction requires the
 * Public Suffix List (https://publicsuffix.org/). Deferred as a future
 * improvement; deferred as a deliberate simplification.
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
 * True for localhost, loopback/private IPs, and ".local" hostnames — dev
 * servers and LAN devices that carry no browsing intent and that context.dev
 * can never resolve.
 */
export function isLocalHost(domain: string): boolean {
  if (domain === "localhost" || domain === "127.0.0.1") return true;
  if (domain.endsWith(".local")) return true;

  // Private IPv4 ranges: 10.x.x.x, 172.16.x.x-172.31.x.x, 192.168.x.x
  const octets = domain.split(".");
  if (octets.length === 4 && octets.every((o) => /^\d{1,3}$/.test(o))) {
    const [a, b] = octets.map(Number);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }

  return false;
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
