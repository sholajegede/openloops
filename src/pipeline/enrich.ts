import { getCachedDomains, putBrands } from "../db/index";
import { isLocalHost } from "../lib/util";
import type { Brand } from "../types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// context.dev REST API (confirmed from https://docs.context.dev)
// Endpoint : GET /brand/retrieve?domain={domain}
// Auth     : Authorization: Bearer {key}  (keys start with ctxt_secret_)
// Cost     : 10 credits per successful call
// 408      : cold-hit cache miss on their side — retry once per docs
// 429      : rate limited — back off
const API_BASE        = "https://api.context.dev/v1";
const LOGO_LINK_BASE  = "https://logos.context.dev";

// Per-request abort after 15 s so a stalled connection can never freeze the UI.
const REQUEST_TIMEOUT_MS = 15_000;
// 3 concurrent per batch, 2 s inter-batch gap → ≈45 req/min, well under the cap.
const BATCH_SIZE     = 3;
const BATCH_DELAY_MS = 2_000;

// ---------------------------------------------------------------------------
// Internal — per-domain fetch with timeout + full diagnostic logging
// ---------------------------------------------------------------------------

interface FetchResult {
  brand: Brand | null;
  errorCode?: string;   // "401", "timeout", "network", etc.
}

async function fetchBrand(domain: string, contextKey: string): Promise<FetchResult> {
  const url = `${API_BASE}/brand/retrieve?domain=${encodeURIComponent(domain)}`;
  const headers = { Authorization: `Bearer ${contextKey}` };

  // One fetch attempt with a hard 15 s abort.
  async function attempt(): Promise<Response> {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { headers, signal: ctrl.signal });
    } finally {
      clearTimeout(tid);
    }
  }

  try {
    let res = await attempt();

    // 408 = cold-hit cache miss; context.dev docs say retry once.
    if (res.status === 408) {
      console.warn(`[openloops] enrich: 408 cold-hit for "${domain}" — retrying once`);
      res = await attempt();
    }

    if (!res.ok) {
      let body = "";
      try { body = (await res.text()).slice(0, 400); } catch { /* ignore */ }
      console.error(
        `[openloops] enrich: ${url}\n` +
        `  → HTTP ${res.status} ${res.statusText}\n` +
        `  body: ${body || "(empty)"}`,
      );
      return { brand: null, errorCode: String(res.status) };
    }

    let data: { status?: string; brand?: Record<string, unknown> };
    try {
      data = await res.json();
    } catch (e) {
      console.error(`[openloops] enrich: JSON parse error for "${domain}"`, e);
      return { brand: null, errorCode: "parse" };
    }

    if (data.status !== "ok" || !data.brand) {
      console.warn(
        `[openloops] enrich: unexpected response shape for "${domain}":`,
        JSON.stringify(data).slice(0, 300),
      );
      return { brand: null, errorCode: "shape" };
    }

    const b = data.brand as {
      title?:        string;
      description?:  string;
      colors?:       { hex?: string }[];
      logos?:        { url?: string }[];
      industries?:   { eic?: { industry?: string; subindustry?: string }[] };
    };

    // Fall back to the keyless logo CDN when the brand record has no logo.
    const logoUrl =
      b.logos?.[0]?.url ||
      `${LOGO_LINK_BASE}?domain=${encodeURIComponent(domain)}`;

    return {
      brand: {
        domain,
        name:        b.title                                      ?? domain,
        description: b.description                                ?? "",
        industry:    b.industries?.eic?.[0]?.industry             ?? "",
        logoUrl,
        brandColor:  b.colors?.[0]?.hex                           ?? "",
      },
    };

  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.error(`[openloops] enrich: 15s timeout for "${domain}"`);
      return { brand: null, errorCode: "timeout" };
    }
    // Likely a CORS block or unreachable host — the error type gives the best clue.
    console.error(`[openloops] enrich: network error for "${domain}":`, err);
    return { brand: null, errorCode: "network" };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve domain names into brand records via the context.dev API.
 *
 * - Already-cached domains are skipped.
 * - Requests are batched with a delay to stay under the rate limit.
 * - Per-domain failures are logged and skipped; the overall call never throws.
 * - Returns enriched/failed counts and a human-readable error string if any
 *   domain failed (useful for surfacing in the UI).
 */
export async function enrichDomains(
  contextKey: string,
  domains: string[],
): Promise<{ enriched: number; failed: number; error?: string }> {
  // Belt-and-suspenders: dev servers / LAN hosts should never reach context.dev,
  // even if one somehow slipped past the noise filter into a thread's domains.
  const unique = [...new Set(domains)].filter((d) => !isLocalHost(d));

  let cached: Set<string>;
  try {
    cached = await getCachedDomains();
  } catch (err) {
    console.error("[openloops] enrich: DB error reading cached domains:", err);
    return { enriched: 0, failed: 0, error: "DB error" };
  }

  const toFetch = unique.filter((d) => !cached.has(d));
  if (toFetch.length === 0) return { enriched: 0, failed: 0 };

  console.log(`[openloops] enrich: resolving ${toFetch.length} uncached domain(s)`);

  let enriched = 0;
  let failed   = 0;
  let firstErrorCode: string | undefined;

  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    const batch   = toFetch.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map((d) => fetchBrand(d, contextKey)));

    const brands = results.map((r) => r.brand).filter((b): b is Brand => b !== null);

    for (const r of results) {
      if (!r.brand) {
        failed += 1;
        if (!firstErrorCode) firstErrorCode = r.errorCode;
      }
    }

    if (brands.length > 0) {
      try {
        await putBrands(brands);
        enriched += brands.length;
      } catch (err) {
        console.error("[openloops] enrich: DB error caching brands:", err);
        failed += brands.length;
        if (!firstErrorCode) firstErrorCode = "DB write";
      }
    }

    if (i + BATCH_SIZE < toFetch.length) {
      await new Promise<void>((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  console.log(`[openloops] enrich: done — ${enriched} enriched, ${failed} failed`);

  // Map internal error codes to user-readable strings.
  let error: string | undefined;
  if (firstErrorCode) {
    const map: Record<string, string> = {
      "401":     "401 — invalid key",
      "403":     "403 — check key permissions",
      "404":     "404 — wrong endpoint (file a bug)",
      "429":     "429 — rate limited, try again later",
      "timeout": "request timeout (15 s)",
      "network": "unreachable — check network/CORS",
      "parse":   "unexpected response format",
      "shape":   "unexpected response shape",
    };
    error = map[firstErrorCode] ?? firstErrorCode;
  }

  return { enriched, failed, error };
}
