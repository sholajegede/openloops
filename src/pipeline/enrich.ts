import { getCachedDomains, putBrands } from "../db/index";
import type { Brand } from "../types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// context.dev API — docs at https://docs.context.dev
// Confirmed endpoint: GET /brand/retrieve?domain={domain}
// Auth: Authorization: Bearer {key}  (keys start with ctxt_secret_)
// Cost: 10 credits per successful call
// 408 = cold-hit timeout (retry once per docs); 429 = rate limited
const API_BASE = "https://api.context.dev/v1";
const LOGO_FALLBACK_BASE = "https://logos.context.dev";

// 3 requests per batch, 5-second inter-batch delay → ≈36 req/min, well under any cap.
const BATCH_SIZE = 3;
const BATCH_DELAY_MS = 5_000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function fetchBrand(domain: string, contextKey: string): Promise<Brand | null> {
  const url = `${API_BASE}/brand/retrieve?domain=${encodeURIComponent(domain)}`;
  const headers = { Authorization: `Bearer ${contextKey}` };

  let res = await fetch(url, { headers });

  // 408 = "cold-hit" cache miss on context.dev's side; docs say retry once.
  if (res.status === 408) {
    res = await fetch(url, { headers });
  }

  if (!res.ok) return null;

  let data: { status: string; brand?: Record<string, unknown> };
  try {
    data = await res.json();
  } catch {
    return null;
  }

  if (data.status !== "ok" || !data.brand) return null;

  const b = data.brand as {
    title?: string;
    description?: string;
    colors?: { hex?: string }[];
    logos?: { url?: string }[];
    industries?: { eic?: { industry?: string }[] };
  };

  // Fall back to the keyless logo CDN when the brand has no logo record.
  const logoUrl =
    b.logos?.[0]?.url ||
    `${LOGO_FALLBACK_BASE}?domain=${encodeURIComponent(domain)}`;

  return {
    domain,
    name:        b.title        ?? domain,
    description: b.description  ?? "",
    industry:    b.industries?.eic?.[0]?.industry ?? "",
    logoUrl,
    brandColor:  b.colors?.[0]?.hex ?? "",
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a list of domains into company brand records via context.dev.
 *
 * Already-cached domains (stored in domain_brands) are skipped.
 * Requests are batched with a delay to stay well under the API rate limit.
 * Individual domain failures are silently skipped — enrichment is best-effort.
 */
export async function enrichDomains(
  contextKey: string,
  domains: string[],
): Promise<{ enriched: number }> {
  const unique = [...new Set(domains)];
  const cached = await getCachedDomains();
  const toFetch = unique.filter((d) => !cached.has(d));

  if (toFetch.length === 0) return { enriched: 0 };

  let enriched = 0;

  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    const batch = toFetch.slice(i, i + BATCH_SIZE);

    const results = await Promise.all(batch.map((d) => fetchBrand(d, contextKey)));
    const brands = results.filter((b): b is Brand => b !== null);

    if (brands.length > 0) {
      await putBrands(brands);
      enriched += brands.length;
    }

    // Delay between batches (skip after the last batch).
    if (i + BATCH_SIZE < toFetch.length) {
      await new Promise<void>((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  return { enriched };
}
