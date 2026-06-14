import { useEffect, useState } from "react";
import { backfillHistory } from "../pipeline/backfill";
import { buildSessions } from "../pipeline/sessions";
import { buildThreads } from "../pipeline/threads";
import { labelThreads } from "../pipeline/label";
import { enrichDomains } from "../pipeline/enrich";
import { getApiKey, setApiKey, getContextKey, setContextKey } from "../lib/settings";
import Assistant from "./Assistant";
import {
  getEventCount,
  getRecentEvents,
  getAllSessions,
  getSessionCount,
  getAllThreads,
  getThreadCount,
  getAllBrands,
} from "../db/index";
import type { RawEvent, Session, IntentThread, Brand } from "../types";

// chrome.runtime.getURL resolves the public/ asset to its extension-package URL.
const logoUrl = chrome.runtime.getURL("openloops-logo.png");

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function relativeTime(epochMs: number): string {
  const seconds = Math.floor((Date.now() - epochMs) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const dateFmt = new Intl.DateTimeFormat(undefined, {
  weekday: "short", month: "short", day: "numeric",
});
const timeFmt = new Intl.DateTimeFormat(undefined, {
  hour: "numeric", minute: "2-digit",
});
const shortDateFmt = new Intl.DateTimeFormat(undefined, {
  month: "short", day: "numeric",
});

function formatSessionTime(startedAt: number, endedAt: number): string {
  return `${dateFmt.format(startedAt)} · ${timeFmt.format(startedAt)} – ${timeFmt.format(endedAt)}`;
}

function formatDuration(startedAt: number, endedAt: number): string {
  const totalMinutes = Math.round((endedAt - startedAt) / 60_000);
  if (totalMinutes < 1) return "<1m";
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// ---------------------------------------------------------------------------
// Resume helper — opens the most-recent meaningful pages in the thread
// ---------------------------------------------------------------------------

// Well-known ambient/utility domains that are unhelpful as "resume" targets.
const RESUME_SKIP_DOMAINS = new Set([
  "google.com", "youtube.com", "bing.com", "duckduckgo.com",
  "gmail.com", "mail.google.com", "google.co.uk", "google.ca",
  "google.com.au", "google.de", "google.fr",
]);

function resumeThread(thread: IntentThread): void {
  const seen = new Set<string>();
  const urls: string[] = [];

  // Sort all events most-recent first, skip ambient domains, dedupe by URL.
  const sorted = thread.sessions
    .flatMap((s) => s.events)
    .sort((a, b) => b.visitedAt - a.visitedAt);

  for (const ev of sorted) {
    if (RESUME_SKIP_DOMAINS.has(ev.domain)) continue;
    if (seen.has(ev.url)) continue;
    seen.add(ev.url);
    urls.push(ev.url);
    if (urls.length >= 3) break;
  }

  // Open most-recent as active, others in background.
  urls.forEach((url, i) => {
    chrome.tabs.create({ url, active: i === 0 });
  });
}

// ---------------------------------------------------------------------------
// DomainChip — shows brand logo when enriched, monogram fallback otherwise
// ---------------------------------------------------------------------------

interface DomainChipProps {
  domain: string;
  logoUrl?: string;
  brandColor?: string;
}

function DomainChip({ domain, logoUrl: chipLogoUrl, brandColor }: DomainChipProps) {
  const [logoFailed, setLogoFailed] = useState(false);
  const showLogo = !!chipLogoUrl && !logoFailed;

  const iconStyle = brandColor ? { background: brandColor + "1a" } : undefined;
  const chipStyle: React.CSSProperties | undefined = brandColor
    ? { boxShadow: `inset 2px 0 0 ${brandColor}88` }
    : undefined;

  return (
    <span className="domain-chip" style={chipStyle}>
      <span className="domain-chip-icon" style={iconStyle}>
        {showLogo ? (
          <img
            src={chipLogoUrl}
            alt=""
            className="domain-chip-logo"
            onError={() => setLogoFailed(true)}
          />
        ) : (
          <span className="domain-chip-monogram">{domain[0].toUpperCase()}</span>
        )}
      </span>
      <span className="domain-chip-label">{domain}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// ThreadCard — leads with meaning, detail tucked away
// ---------------------------------------------------------------------------

interface ThreadCardProps {
  thread: IntentThread;
  brands: Map<string, Brand>;
  isSelected: boolean;
  onSelect: () => void;
}

function ThreadCard({ thread, brands, isSelected, onSelect }: ThreadCardProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);

  const totalEvents = thread.sessions.reduce((n, s) => n + s.events.length, 0);
  const topDomains  = [...new Set(thread.sessions.flatMap((s) => s.domains))].slice(0, 4);
  const allKeywords = [...new Set(thread.sessions.flatMap((s) => s.keywords))].slice(0, 8);

  return (
    <li
      className={`thread-card${isSelected ? " thread-card-selected" : ""}`}
      onClick={onSelect}
    >
      {/* ── Title + type/status pill ── */}
      <div className="thread-header">
        <div className="thread-title-block">
          <h3 className="thread-title">{thread.title}</h3>
        </div>
        <div className="thread-label-group">
          <span className="thread-type-label">{thread.type.toUpperCase()}</span>
          <span className={`thread-status-pill thread-status-pill-${thread.status}`}>
            {thread.status.toUpperCase()}
          </span>
        </div>
      </div>

      {/* ── Summary — primary human sentence ── */}
      {thread.summary && (
        <p className="thread-summary">{thread.summary}</p>
      )}

      {/* ── Next step + Resume ── */}
      {thread.nextStep && (
        <div className="thread-next-row">
          <span className="thread-next-marker">→</span>
          <span className="thread-next-text">{thread.nextStep}</span>
          <button
            type="button"
            className="thread-resume-btn"
            onClick={(e) => { e.stopPropagation(); resumeThread(thread); }}
          >
            Resume
          </button>
        </div>
      )}

      {/* ── Confidence bar ── */}
      <div className="confidence-row">
        <div className="confidence-bar-track">
          <div className="confidence-bar-fill" style={{ width: `${thread.confidence * 100}%` }} />
        </div>
        <span className="confidence-pct">{Math.round(thread.confidence * 100)}%</span>
      </div>

      {/* ── Details toggle ── */}
      <button
        type="button"
        className="thread-details-toggle"
        onClick={(e) => { e.stopPropagation(); setDetailsOpen((v) => !v); }}
      >
        {detailsOpen ? "▲ hide details" : "▼ details"}
      </button>

      {/* ── Collapsible details ── */}
      {detailsOpen && (
        <div className="thread-details">
          <p className="thread-meta">
            {thread.sessions.length} session{thread.sessions.length !== 1 ? "s" : ""}
            {" · "}{totalEvents} event{totalEvents !== 1 ? "s" : ""}
            {" · "}{thread.distinctDays} day{thread.distinctDays !== 1 ? "s" : ""}
            {" · "}{relativeTime(thread.lastSeen)}
          </p>

          {topDomains.length > 0 && (
            <div className="domain-chips">
              {topDomains.map((d) => (
                <DomainChip
                  key={d}
                  domain={d}
                  logoUrl={brands.get(d)?.logoUrl}
                  brandColor={brands.get(d)?.brandColor}
                />
              ))}
            </div>
          )}

          {allKeywords.length > 0 && (
            <div className="keyword-tags">
              {allKeywords.map((kw) => (
                <span key={kw} className="keyword-tag">{kw}</span>
              ))}
            </div>
          )}

          {thread.signals.length > 0 && (
            <ul className="signals-list">
              {thread.signals.map((sig) => (
                <li key={sig} className="signal-item">{sig}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Session row
// ---------------------------------------------------------------------------

function SessionRow({ session }: { session: Session }) {
  return (
    <li className="session-item">
      <div className="session-time">
        {formatSessionTime(session.startedAt, session.endedAt)}
        <span className="session-duration">
          {formatDuration(session.startedAt, session.endedAt)}
          {" · "}
          {session.events.length} event{session.events.length !== 1 ? "s" : ""}
        </span>
      </div>
      <div className="session-domains">
        {session.domains.slice(0, 3).map((d) => (
          <span key={d} className="session-domain">{d}</span>
        ))}
      </div>
      {session.keywords.length > 0 && (
        <div className="keyword-tags">
          {session.keywords.map((kw) => (
            <span key={kw} className="keyword-tag">{kw}</span>
          ))}
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Overview stats (right column, above the assistant)
// ---------------------------------------------------------------------------

interface OverviewStatsProps {
  eventCount: number | null;
  sessionCount: number | null;
  threads: IntentThread[];
}

function OverviewStats({ eventCount, sessionCount, threads }: OverviewStatsProps) {
  const [statsOpen, setStatsOpen] = useState(false);

  const totalThreads = threads.length;

  const statusCounts = {
    active:  threads.filter((t) => t.status === "active").length,
    stalled: threads.filter((t) => t.status === "stalled").length,
    dormant: threads.filter((t) => t.status === "dormant").length,
  };

  const domainMap = new Map<string, { events: number; threads: number }>();
  for (const thread of threads) {
    const threadDomains = new Set<string>();
    for (const session of thread.sessions) {
      for (const domain of session.domains) threadDomains.add(domain);
      for (const event of session.events) {
        const entry = domainMap.get(event.domain) ?? { events: 0, threads: 0 };
        entry.events += 1;
        domainMap.set(event.domain, entry);
      }
    }
    for (const domain of threadDomains) {
      const entry = domainMap.get(domain) ?? { events: 0, threads: 0 };
      entry.threads += 1;
      domainMap.set(domain, entry);
    }
  }
  const topDomains = [...domainMap.entries()]
    .sort((a, b) => b[1].events - a[1].events)
    .slice(0, 5);

  const allTimestamps = threads.flatMap((t) => [t.firstSeen, t.lastSeen]);
  const dateStart = allTimestamps.length > 0 ? Math.min(...allTimestamps) : null;
  const dateEnd   = allTimestamps.length > 0 ? Math.max(...allTimestamps) : null;

  const barWidth = (count: number) =>
    totalThreads > 0 ? `${Math.round((count / totalThreads) * 100)}%` : "0%";

  return (
    <div className="overview-stats">
      <div className="overview-eyebrow">Overview</div>

      {/* Compact totals row */}
      <div className="overview-totals-row">
        <div className="overview-stat-compact">
          <span className="overview-stat-value">
            {eventCount !== null && eventCount > 0 ? eventCount.toLocaleString() : "—"}
          </span>
          <span className="overview-stat-label">events</span>
        </div>
        <div className="overview-stat-compact">
          <span className="overview-stat-value">
            {sessionCount !== null && sessionCount > 0 ? sessionCount.toLocaleString() : "—"}
          </span>
          <span className="overview-stat-label">sessions</span>
        </div>
        <div className="overview-stat-compact">
          <span className="overview-stat-value">
            {totalThreads > 0 ? totalThreads.toLocaleString() : "—"}
          </span>
          <span className="overview-stat-label">threads</span>
        </div>
      </div>

      {/* Detailed stats — collapsed by default */}
      <div className="overview-stats-disclosure">
        <button type="button" className="collapsible-header" onClick={() => setStatsOpen((v) => !v)}>
          <span className="collapsible-title">Stats</span>
          <span className="collapsible-chevron">{statsOpen ? "▲" : "▼"}</span>
        </button>

        {statsOpen && (
          <div className="overview-stats-body">
            {totalThreads > 0 && (
              <div className="overview-section">
                <div className="overview-section-label">Status</div>
                {(["active", "stalled", "dormant"] as const).map((s) => (
                  <div key={s} className="overview-status-row">
                    <span className="overview-status-name">{s.toUpperCase()}</span>
                    <div className="overview-status-track">
                      <div
                        className={`overview-status-fill overview-status-fill-${s}`}
                        style={{ width: barWidth(statusCounts[s]) }}
                      />
                    </div>
                    <span className="overview-status-count">{statusCounts[s]}</span>
                  </div>
                ))}
              </div>
            )}

            {topDomains.length > 0 && (
              <div className="overview-section">
                <div className="overview-section-label">Top Domains</div>
                {topDomains.map(([domain, stats]) => (
                  <div key={domain} className="overview-domain-row">
                    <span className="overview-domain-name">{domain}</span>
                    <span className="overview-domain-stats">
                      {stats.events}ev · {stats.threads}th
                    </span>
                  </div>
                ))}
              </div>
            )}

            {dateStart !== null && dateEnd !== null && (
              <div className="overview-section">
                <div className="overview-section-label">Date Range</div>
                <div className="overview-date-range">
                  {shortDateFmt.format(dateStart)}
                  <span className="overview-date-sep"> → </span>
                  {shortDateFmt.format(dateEnd)}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALL_STATUSES: IntentThread["status"][] = ["active", "stalled", "dormant"];

const STATUS_DOT_CLASS: Record<IntentThread["status"], string> = {
  active:  "dot-active",
  stalled: "dot-stalled",
  dormant: "dot-dormant",
};

// ---------------------------------------------------------------------------
// Pipeline button states
// ---------------------------------------------------------------------------

type PipelineState = "disabled" | "next" | "done";

/**
 * Each pipeline button is DISABLED until its input exists, NEXT (accent
 * highlight) for the first step whose output doesn't exist yet, or DONE
 * (normal styling, re-runnable) once its output exists.
 */
function pipelineStates(
  eventCount: number | null,
  sessionCount: number | null,
  threadCount: number | null,
): { scan: PipelineState; sessions: PipelineState; threads: PipelineState } {
  const hasEvents   = (eventCount   ?? 0) > 0;
  const hasSessions = (sessionCount ?? 0) > 0;
  const hasThreads  = (threadCount  ?? 0) > 0;

  if (!hasEvents)   return { scan: "next",   sessions: "disabled", threads: "disabled" };
  if (!hasSessions) return { scan: "done",   sessions: "next",     threads: "disabled" };
  if (!hasThreads)  return { scan: "done",   sessions: "done",     threads: "next" };
  return { scan: "done", sessions: "done", threads: "done" };
}

// ---------------------------------------------------------------------------
// WelcomeScreen — centered onboarding shown until the first intent map exists
// ---------------------------------------------------------------------------

interface WelcomeScreenProps {
  logoUrl: string;
  currentStep: 1 | 2 | 3;
  ctaLabel: string;
  ctaDisabled: boolean;
  onCtaClick: () => void;
}

const WELCOME_STEPS = ["Scan your history", "Build sessions", "Build your intent map"];

function WelcomeScreen({ logoUrl, currentStep, ctaLabel, ctaDisabled, onCtaClick }: WelcomeScreenProps) {
  return (
    <div className="welcome-screen">
      <img src={logoUrl} alt="" className="welcome-logo" />
      <h1 className="welcome-title">openloops</h1>
      <p className="welcome-tagline">the AI intelligence for your browser history</p>
      <p className="welcome-explainer">
        Scans your browsing history, groups it into the things you were actually
        trying to do, and helps you close the loop.
      </p>
      <ol className="welcome-steps">
        {WELCOME_STEPS.map((label, i) => (
          <li
            key={label}
            className={`welcome-step${i + 1 === currentStep ? " welcome-step-active" : ""}`}
          >
            <span className="welcome-step-number">{i + 1}</span>
            <span className="welcome-step-label">{label}</span>
          </li>
        ))}
      </ol>
      <button type="button" className="welcome-cta" onClick={onCtaClick} disabled={ctaDisabled}>
        {ctaLabel}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  // Pipeline data
  const [eventCount, setEventCount]             = useState<number | null>(null);
  const [recentEvents, setRecentEvents]         = useState<RawEvent[]>([]);
  const [scanning, setScanning]                 = useState(false);
  const [sessionCount, setSessionCount]         = useState<number | null>(null);
  const [sessions, setSessions]                 = useState<Session[]>([]);
  const [filteredEventCount, setFilteredEventCount] = useState<number | null>(null);
  const [buildingSessions, setBuildingSessions] = useState(false);
  const [threadCount, setThreadCount]           = useState<number | null>(null);
  const [threads, setThreads]                   = useState<IntentThread[]>([]);
  const [buildingThreads, setBuildingThreads]   = useState(false);

  // Brand enrichment
  const [contextKey, setContextKeyState]       = useState("");
  const [contextKeySaved, setContextKeySaved]  = useState(false);
  const [enriching, setEnriching]              = useState(false);
  const [enrichError, setEnrichError]          = useState<string | null>(null);
  const [brands, setBrands]                    = useState<Map<string, Brand>>(new Map());

  // AI labeling
  const [apiKey, setApiKeyState]    = useState("");
  const [keySaved, setKeySaved]     = useState(false);
  const [labeling, setLabeling]     = useState(false);
  const [labelError, setLabelError] = useState<string | null>(null);

  // UI state
  const [visibleStatuses, setVisibleStatuses] = useState<Set<IntentThread["status"]>>(
    new Set(ALL_STATUSES)
  );
  const [sessionsOpen, setSessionsOpen]     = useState(false);
  const [eventsOpen, setEventsOpen]         = useState(false);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);

  useEffect(() => {
    void refreshAll();
    void getApiKey().then((saved) => {
      if (saved) { setApiKeyState(saved); setKeySaved(true); }
    });
    void getContextKey().then((saved) => {
      if (saved) { setContextKeyState(saved); setContextKeySaved(true); }
    });
    void getAllBrands().then((all) => {
      setBrands(new Map(all.map((b) => [b.domain, b])));
    });
  }, []);

  async function refreshAll() {
    const [ec, recent, sc, allSessions, tc, allThreads] = await Promise.all([
      getEventCount(),
      getRecentEvents(20),
      getSessionCount(),
      getAllSessions(),
      getThreadCount(),
      getAllThreads(),
    ]);
    setEventCount(ec);
    setRecentEvents(recent);
    setSessionCount(sc);
    setSessions([...allSessions].reverse());
    if (allSessions.length > 0) {
      setFilteredEventCount(allSessions.reduce((n, s) => n + s.events.length, 0));
    }
    setThreadCount(tc);
    setThreads(allThreads);
  }

  async function handleScan() {
    setScanning(true);
    try { await backfillHistory(14); await refreshAll(); }
    finally { setScanning(false); }
  }

  async function handleBuildSessions() {
    setBuildingSessions(true);
    try {
      const result = await buildSessions();
      setFilteredEventCount(result.events);
      const allSessions = await getAllSessions();
      setSessionCount(allSessions.length);
      setSessions([...allSessions].reverse());
    } finally { setBuildingSessions(false); }
  }

  async function handleBuildThreads() {
    setBuildingThreads(true);
    try {
      const result = await buildThreads();
      setThreadCount(result.threads);
      setThreads(await getAllThreads());
    } finally { setBuildingThreads(false); }
  }

  async function handleSaveContextKey() {
    await setContextKey(contextKey.trim());
    setContextKeySaved(true);
  }

  async function handleSaveKey() {
    await setApiKey(apiKey.trim());
    setKeySaved(true);
    setLabelError(null);
  }

  async function handleEnrichAndLabel() {
    setLabelError(null);
    setEnrichError(null);

    // Enrichment phase — skip if no context.dev key is saved.
    // enrichDomains never throws; button state always resets via finally.
    if (contextKey.trim() && contextKeySaved) {
      setEnriching(true);
      try {
        const allDomains = [...new Set(
          threads.flatMap((t) => t.sessions.flatMap((s) => s.domains))
        )];
        const result = await enrichDomains(contextKey.trim(), allDomains);
        if (result.error) {
          setEnrichError(`context.dev: ${result.error}`);
        }
        if (result.enriched > 0) {
          const all = await getAllBrands();
          setBrands(new Map(all.map((b) => [b.domain, b])));
        }
      } catch (err) {
        setEnrichError(`context.dev: ${err instanceof Error ? err.message : "unknown error"}`);
      } finally {
        setEnriching(false);
      }
    }

    // Always proceed to labeling regardless of enrichment outcome.
    setLabeling(true);
    try {
      await labelThreads(apiKey.trim());
      setThreads(await getAllThreads());
    } catch (err) {
      setLabelError(err instanceof Error ? err.message : "Labeling failed.");
    } finally {
      setLabeling(false);
    }
  }

  function toggleStatus(s: IntentThread["status"]) {
    setVisibleStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });
  }

  function toggleSelect(id: string) {
    setSelectedThreadId((prev) => (prev === id ? null : id));
  }

  // Group threads by status, sorted by confidence desc within each group
  const statusGroups = ALL_STATUSES.map((s) => ({
    status: s,
    items: threads
      .filter((t) => t.status === s)
      .sort((a, b) => b.confidence - a.confidence),
  }));

  const statusCounts = Object.fromEntries(
    statusGroups.map(({ status, items }) => [status, items.length])
  ) as Record<IntentThread["status"], number>;

  const selectedThread = threads.find((t) => t.id === selectedThreadId) ?? null;

  const { scan: scanState, sessions: sessionsState, threads: threadsState } =
    pipelineStates(eventCount, sessionCount, threadCount);

  // The welcome screen's single CTA mirrors whichever rail action is NEXT.
  let welcomeStep: 1 | 2 | 3 = 1;
  let welcomeCtaLabel = "Scan my history";
  let welcomeCtaDisabled = false;
  let welcomeCtaClick = handleScan;
  if (scanState === "next") {
    welcomeStep = 1;
    welcomeCtaLabel = scanning ? "Scanning…" : "Scan my history";
    welcomeCtaDisabled = scanning;
    welcomeCtaClick = handleScan;
  } else if (sessionsState === "next") {
    welcomeStep = 2;
    welcomeCtaLabel = buildingSessions ? "Building…" : "Build sessions";
    welcomeCtaDisabled = buildingSessions;
    welcomeCtaClick = handleBuildSessions;
  } else if (threadsState === "next") {
    welcomeStep = 3;
    welcomeCtaLabel = buildingThreads ? "Building…" : "Build your intent map";
    welcomeCtaDisabled = buildingThreads;
    welcomeCtaClick = handleBuildThreads;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="app-shell">

      {/* ── Left rail ── */}
      <aside className="rail">
        <div className="rail-wordmark">
          <img src={logoUrl} alt="" className="rail-logo" />
          <span>openloops</span>
        </div>

        {/* Pipeline actions */}
        <div className="rail-section">
          <div className="rail-eyebrow">Pipeline</div>

          <button
            type="button"
            className={`rail-action${scanState === "next" ? " rail-action-accent" : ""}`}
            onClick={handleScan}
            disabled={scanning}
          >
            <span className="rail-action-label">
              {scanning ? "Scanning…" : "Scan my history"}
            </span>
            <span className="rail-action-count">
              {scanState === "done" && eventCount
                ? `${eventCount.toLocaleString()} events` : "—"}
            </span>
          </button>

          <button
            type="button"
            className={`rail-action${sessionsState === "next" ? " rail-action-accent" : ""}`}
            onClick={handleBuildSessions}
            disabled={buildingSessions || sessionsState === "disabled"}
          >
            <span className="rail-action-label">
              {buildingSessions ? "Building…" : "Build sessions"}
            </span>
            <span className="rail-action-count">
              {sessionsState === "done" && sessionCount
                ? `${sessionCount.toLocaleString()} sessions` : "—"}
            </span>
          </button>

          <button
            type="button"
            className={`rail-action${threadsState === "next" ? " rail-action-accent" : ""}`}
            onClick={handleBuildThreads}
            disabled={buildingThreads || threadsState === "disabled"}
          >
            <span className="rail-action-label">
              {buildingThreads ? "Building…" : "Build intent map"}
            </span>
            <span className="rail-action-count">
              {threadsState === "done" && threadCount
                ? `${threadCount.toLocaleString()} thread${threadCount !== 1 ? "s" : ""}` : "—"}
            </span>
          </button>
        </div>

        {/* Intelligence */}
        <div className="rail-section">
          <div className="rail-eyebrow">Intelligence</div>
          <div className="rail-key-area">

            {/* context.dev key */}
            <input
              className="rail-key-input"
              type="password"
              placeholder="ctxt_secret_… (context.dev)"
              value={contextKey}
              onChange={(e) => { setContextKeyState(e.target.value); setContextKeySaved(false); }}
            />
            <div className="rail-key-btns">
              <button
                type="button"
                className="rail-btn"
                onClick={handleSaveContextKey}
                disabled={!contextKey.trim() || contextKeySaved}
              >
                {contextKeySaved ? "Saved ✓" : "Save key"}
              </button>
            </div>
            <p className="rail-key-note">
              Enrichment sends domain names (not URLs or history) to context.dev.
            </p>

            {/* Anthropic key */}
            <input
              className="rail-key-input"
              type="password"
              placeholder="sk-ant-… (Anthropic)"
              value={apiKey}
              onChange={(e) => { setApiKeyState(e.target.value); setKeySaved(false); }}
            />
            <div className="rail-key-btns">
              <button
                type="button"
                className="rail-btn"
                onClick={handleSaveKey}
                disabled={!apiKey.trim() || keySaved}
              >
                {keySaved ? "Saved ✓" : "Save key"}
              </button>
              <button
                type="button"
                className="rail-btn rail-btn-accent"
                onClick={handleEnrichAndLabel}
                disabled={enriching || labeling || !keySaved || threads.length === 0}
              >
                {enriching ? "Enriching…" : labeling ? "Labeling…" : "Label & enrich"}
              </button>
            </div>
            {enrichError && <p className="enrich-error">{enrichError}</p>}
            {labelError  && <p className="label-error">{labelError}</p>}
          </div>
        </div>

        {/* Status filter */}
        <div className="rail-section">
          <div className="rail-eyebrow">Filter</div>
          {ALL_STATUSES.map((s) => {
            const on = visibleStatuses.has(s);
            return (
              <button
                key={s}
                type="button"
                className={`filter-row${on ? "" : " off"}`}
                onClick={() => toggleStatus(s)}
              >
                <span className={`filter-dot ${STATUS_DOT_CLASS[s]}`} />
                <span className="filter-label">{s}</span>
                {statusCounts[s] > 0 && (
                  <span className="filter-count">{statusCounts[s]}</span>
                )}
              </button>
            );
          })}
        </div>
      </aside>

      {/* ── Main column ── */}
      <main className="main-col">
        {threadCount === 0 || threadCount === null ? (
          <WelcomeScreen
            logoUrl={logoUrl}
            currentStep={welcomeStep}
            ctaLabel={welcomeCtaLabel}
            ctaDisabled={welcomeCtaDisabled}
            onCtaClick={welcomeCtaClick}
          />
        ) : (
          <div className="intent-map">
            {statusGroups.map(({ status, items }) => {
              if (!visibleStatuses.has(status) || items.length === 0) return null;
              return (
                <section key={status} className="status-group">
                  <div className="status-group-header">
                    <span className={`status-eyebrow-dot ${STATUS_DOT_CLASS[status]}`} />
                    <h2 className="status-eyebrow">
                      {status.toUpperCase()}
                      <span className="status-eyebrow-count"> · {items.length}</span>
                    </h2>
                  </div>
                  <ul className="thread-list">
                    {items.map((t) => (
                      <ThreadCard
                        key={t.id}
                        thread={t}
                        brands={brands}
                        isSelected={selectedThreadId === t.id}
                        onSelect={() => toggleSelect(t.id)}
                      />
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}

        {/* Pipeline detail — collapsible */}
        <div className="pipeline-detail">
          <div className="pipeline-detail-eyebrow">Pipeline Detail</div>

          <div className="collapsible-section">
            <button
              type="button"
              className="collapsible-header"
              onClick={() => setSessionsOpen((v) => !v)}
            >
              <span className="collapsible-title">
                Sessions
                {sessionCount !== null && sessionCount > 0 && (
                  <span className="collapsible-count"> · {sessionCount.toLocaleString()}</span>
                )}
                {filteredEventCount !== null && filteredEventCount > 0 && sessionCount !== null && sessionCount > 0 && (
                  <span className="collapsible-count"> ({filteredEventCount.toLocaleString()} events)</span>
                )}
              </span>
              <span className="collapsible-chevron">{sessionsOpen ? "▲" : "▼"}</span>
            </button>
            {sessionsOpen && sessions.length > 0 && (
              <ul className="session-list">
                {sessions.map((s) => <SessionRow key={s.id} session={s} />)}
              </ul>
            )}
          </div>

          <div className="collapsible-section">
            <button
              type="button"
              className="collapsible-header"
              onClick={() => setEventsOpen((v) => !v)}
            >
              <span className="collapsible-title">
                Raw Events
                {eventCount !== null && eventCount > 0 && (
                  <span className="collapsible-count"> · {eventCount.toLocaleString()}</span>
                )}
              </span>
              <span className="collapsible-chevron">{eventsOpen ? "▲" : "▼"}</span>
            </button>
            {eventsOpen && recentEvents.length > 0 && (
              <>
                <p className="collapsible-note">20 most recent</p>
                <ul className="event-list">
                  {recentEvents.map((e) => (
                    <li key={e.id} className="event-item">
                      <span className="event-title">{e.title}</span>
                      <span className="event-meta">
                        <span className="event-domain">{e.domain}</span>
                        <span className="event-time">{relativeTime(e.visitedAt)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>

        <footer className="main-footer">
          <span className="brand-credit">
            brand data by{" "}
            <a
              href="https://context.dev"
              target="_blank"
              rel="noopener noreferrer"
              className="brand-credit-link"
            >
              context.dev
            </a>
          </span>
        </footer>
      </main>

      {/* ── Right column: condensed stats + assistant ── */}
      <aside className="overview-panel">
        <OverviewStats
          eventCount={eventCount}
          sessionCount={sessionCount}
          threads={threads}
        />
        <Assistant
          threads={threads}
          brands={brands}
          selectedThread={selectedThread}
          apiKey={apiKey}
          keySaved={keySaved}
          onClearFocus={() => setSelectedThreadId(null)}
        />
      </aside>
    </div>
  );
}
