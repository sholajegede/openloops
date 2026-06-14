import { getAllThreads, putThreads, getAllBrands } from "../db/index";
import type { IntentThread } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ThreadDescriptor {
  id: string;
  keywords: string[];
  domains: string[];
  sampleTitles: string[];
  domainContext: string[];  // "stripe.com: Stripe — Online payments (Fintech)"
}

interface LabelResult {
  id: string;
  title: string;
  summary: string;
  type: string;
  nextStep: string;
}

const VALID_TYPES: ReadonlySet<IntentThread["type"]> = new Set([
  "buying",
  "research",
  "learning",
  "planning",
  "unclassified",
]);

// Threads per request. Each thread's response (title + summary + type +
// nextStep) costs a few hundred output tokens, so 10 threads stays well
// within MAX_TOKENS_PER_BATCH while keeping request count reasonable.
const BATCH_SIZE = 10;
const MAX_TOKENS_PER_BATCH = 4000;

// ---------------------------------------------------------------------------
// Internal — one batch request to Claude
// ---------------------------------------------------------------------------

/**
 * Send one batch of thread descriptors to Claude and parse the JSON array
 * response. Returns null (and logs diagnostics) if the response couldn't be
 * parsed, so the caller can skip just this batch and keep going.
 *
 * @throws Error with the HTTP status if the request itself fails (auth,
 * rate limit, etc.) — this aborts the whole labeling run since every
 * subsequent batch would fail the same way.
 */
async function callClaudeBatch(
  apiKey: string,
  systemPrompt: string,
  batch: ThreadDescriptor[],
): Promise<LabelResult[] | null> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: MAX_TOKENS_PER_BATCH,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: JSON.stringify(batch),
        },
      ],
    }),
  });

  if (!response.ok) {
    let body = "";
    try { body = (await response.text()).slice(0, 400); } catch { /* ignore */ }
    console.error(
      `[openloops] label: API request failed\n` +
      `  → HTTP ${response.status} ${response.statusText}\n` +
      `  body: ${body || "(empty)"}`,
    );
    if (response.status === 401) {
      throw new Error("Invalid API key. Check your Anthropic API key and try again.");
    }
    throw new Error(`API request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const raw: string = data.content[0].text;
  console.log(`[openloops] label: batch raw.length = ${raw.length}`);

  // Trim, then strip a leading ```json / ``` fence and a trailing ``` fence,
  // tolerating surrounding whitespace/newlines.
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/```\s*$/, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    console.error(`[openloops] label: parse error: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`[openloops] label: raw tail (last 400 chars):\n${raw.slice(-400)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send all stored threads to Claude Haiku in batches and write AI-generated
 * titles, summaries, types, and next steps back to IndexedDB.
 *
 * Uses raw fetch() because the Anthropic TypeScript SDK does not support
 * browser/extension environments. The `anthropic-dangerous-direct-browser-access`
 * header is required for any browser-originated call to api.anthropic.com.
 *
 * @throws Error with a human-readable message (includes "Invalid API key" on 401,
 * or the HTTP status for other request-level failures)
 */
export async function labelThreads(apiKey: string): Promise<{ labeled: number }> {
  const threads = await getAllThreads();
  if (threads.length === 0) return { labeled: 0 };

  // Load any cached brand records so descriptors can include company context.
  const allBrands = await getAllBrands();
  const brandMap = new Map(allBrands.map((b) => [b.domain, b]));

  // Build compact descriptors — only what Claude needs to understand each thread.
  const descriptors: ThreadDescriptor[] = threads.map((t) => {
    const keywords = [...new Set(t.sessions.flatMap((s) => s.keywords))].slice(0, 8);
    const domains  = [...new Set(t.sessions.flatMap((s) => s.domains))].slice(0, 5);
    const titles   = [...new Set(t.sessions.flatMap((s) => s.events.map((e) => e.title)))].slice(0, 20);

    // Compact company context grounded in enriched brand records.
    // e.g. "stripe.com: Stripe — Online payment processing for internet businesses (Fintech)"
    const domainContext = domains
      .map((d) => {
        const brand = brandMap.get(d);
        if (!brand || !brand.name) return null;
        let line = `${d}: ${brand.name}`;
        if (brand.description) line += ` — ${brand.description}`;
        if (brand.industry)    line += ` (${brand.industry})`;
        return line;
      })
      .filter((s): s is string => s !== null);

    return { id: t.id, keywords, domains, sampleTitles: titles, domainContext };
  });

  const systemPrompt = `You label browsing intent threads. Return ONLY a JSON array — no markdown fences, no explanation.
Each element: { "id": "<thread id>", "title": "<3-6 word title>", "summary": "<1 sentence>", "type": "<buying|research|learning|planning|unclassified>", "nextStep": "<one concrete, specific action to move this thread forward or close the loop>" }
The nextStep must be grounded in what the person was actually looking at. Be specific — name the actual decision, comparison, or action (e.g. "Decide between MacBook Pro and Dell XPS — your open question was battery life") rather than generic advice ("continue researching"). Use the sampleTitles and domainContext to ground it.
Each thread descriptor may include a "domainContext" array of company descriptions for the sites visited. When present, use these to produce sharper, more specific titles, summaries, and next steps grounded in what each company actually does.
Respond with exactly one array covering every thread in the request.`;

  // Run batches sequentially — simple, and avoids bursting the rate limit.
  const allResults: LabelResult[] = [];
  let failedBatches = 0;
  for (let i = 0; i < descriptors.length; i += BATCH_SIZE) {
    const batch = descriptors.slice(i, i + BATCH_SIZE);
    const results = await callClaudeBatch(apiKey, systemPrompt, batch);
    if (results === null) {
      failedBatches++;
      continue; // skip this batch; its threads keep their heuristic values
    }
    allResults.push(...results);
  }

  // Build a lookup by thread id for O(1) merging.
  const byId = new Map(allResults.map((r) => [r.id, r]));

  let labeled = 0;
  const updated = threads.map((t) => {
    const label = byId.get(t.id);
    if (!label) return t;

    const type = VALID_TYPES.has(label.type as IntentThread["type"])
      ? (label.type as IntentThread["type"])
      : t.type;

    labeled++;
    return {
      ...t,
      title:    label.title    || t.title,
      summary:  label.summary  || undefined,
      nextStep: label.nextStep || undefined,
      type,
    };
  });

  console.log(`[openloops] label: applied ${labeled}/${threads.length} threads (${failedBatches} batch(es) failed to parse)`);
  if (labeled === 0) {
    console.log(`[openloops] label: expected thread ids:`, threads.slice(0, 3).map((t) => t.id));
    console.log(`[openloops] label: returned result ids:`, allResults.slice(0, 3).map((r) => r.id));
  }

  await putThreads(updated);
  return { labeled };
}
