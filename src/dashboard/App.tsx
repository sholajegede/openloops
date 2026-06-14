import { useEffect, useState } from "react";
import { backfillHistory } from "../pipeline/backfill";
import { buildSessions } from "../pipeline/sessions";
import { buildThreads } from "../pipeline/threads";
import { labelThreads } from "../pipeline/label";
import { enrichDomains } from "../pipeline/enrich";
import { getApiKey, setApiKey, getContextKey, setContextKey } from "../lib/settings";
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
// DomainChip — shows brand logo when enriched, monogram fallback otherwise
// ---------------------------------------------------------------------------

interface DomainChipProps {
  domain: string;
  logoUrl?: string;
  brandColor?: string;
}

function DomainChip({ domain, logoUrl, brandColor }: DomainChipProps) {
  const [logoFailed, setLogoFailed] = useState(false);
  const showLogo = !!logoUrl && !logoFailed;

  const iconStyle = brandColor ? { background: brandColor + "1a" } : undefined;
  // Subtle inset-left accent — doesn't affect layout, keeps it restrained.
  const chipStyle: React.CSSProperties | undefined = brandColor
    ? { boxShadow: `inset 2px 0 0 ${brandColor}88` }
    : undefined;

  return (
    <span className="domain-chip" style={chipStyle}>
      <span className="domain-chip-icon" style={iconStyle}>
        {showLogo ? (
          <img
            src={logoUrl}
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
// ThreadCard
// ---------------------------------------------------------------------------

function ThreadCard({ thread, brands }: { thread: IntentThread; brands: Map<string, Brand> }) {
  const totalEvents = thread.sessions.reduce((n, s) => n + s.events.length, 0);
  const topDomains  = [...new Set(thread.sessions.flatMap((s) => s.domains))].slice(0, 4);
  const allKeywords = [...new Set(thread.sessions.flatMap((s) => s.keywords))].slice(0, 8);

  return (
    <li className="thread-card">

      {/* ── Title + type/status ── */}
      <div className="thread-header">
        <div className="thread-title-block">
          <h3 className="thread-title">{thread.title}</h3>
          {thread.summary && <p className="thread-summary">{thread.summary}</p>}
        </div>
        <div className="thread-label-group">
          <span className="thread-type-label">{thread.type.toUpperCase()}</span>
          <span className={`thread-status-pill thread-status-pill-${thread.status}`}>
            {thread.status.toUpperCase()}
          </span>
        </div>
      </div>

      {/* ── Confidence bar ── */}
      <div className="confidence-row">
        <div className="confidence-bar-track">
          <div className="confidence-bar-fill" style={{ width: `${thread.confidence * 100}%` }} />
        </div>
        <span className="confidence-pct">{Math.round(thread.confidence * 100)}%</span>
      </div>

      {/* ── Meta row ── */}
      <p className="thread-meta">
        {thread.sessions.length} session{thread.sessions.length !== 1 ? "s" : ""}
        {" · "}{totalEvents} event{totalEvents !== 1 ? "s" : ""}
        {" · "}{thread.distinctDays} day{thread.distinctDays !== 1 ? "s" : ""}
        {" · "}{relativeTime(thread.lastSeen)}
      </p>

      {/* ── Domain chips ── */}
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

      {/* ── Keywords ── */}
      {allKeywords.length > 0 && (
        <div className="keyword-tags">
          {allKeywords.map((kw) => (
            <span key={kw} className="keyword-tag">{kw}</span>
          ))}
        </div>
      )}

      {/* ── Signals ── */}
      {thread.signals.length > 0 && (
        <ul className="signals-list">
          {thread.signals.map((sig) => (
            <li key={sig} className="signal-item">{sig}</li>
          ))}
        </ul>
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
// Constants
// ---------------------------------------------------------------------------

const ALL_STATUSES: IntentThread["status"][] = ["active", "stalled", "dormant"];

const STATUS_DOT_CLASS: Record<IntentThread["status"], string> = {
  active:  "dot-active",
  stalled: "dot-stalled",
  dormant: "dot-dormant",
};

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
  const [brands, setBrands]                    = useState<Map<string, Brand>>(new Map());

  // AI labeling
  const [apiKey, setApiKeyState]   = useState("");
  const [keySaved, setKeySaved]    = useState(false);
  const [labeling, setLabeling]    = useState(false);
  const [labelError, setLabelError] = useState<string | null>(null);

  // UI state
  const [visibleStatuses, setVisibleStatuses] = useState<Set<IntentThread["status"]>>(
    new Set(ALL_STATUSES)
  );
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [eventsOpen, setEventsOpen]     = useState(false);

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

    // Enrichment phase — skip gracefully if no context.dev key is saved.
    if (contextKey.trim() && contextKeySaved) {
      setEnriching(true);
      try {
        const allDomains = [...new Set(
          threads.flatMap((t) => t.sessions.flatMap((s) => s.domains))
        )];
        await enrichDomains(contextKey.trim(), allDomains);
        // Reload brand cache into state so chips update immediately.
        const all = await getAllBrands();
        setBrands(new Map(all.map((b) => [b.domain, b])));
      } catch (err) {
        // Enrichment failure is non-fatal — log and proceed to labeling.
        console.warn("[openloops] enrichment failed:", err);
      } finally {
        setEnriching(false);
      }
    }

    // Labeling phase — requires the Anthropic key.
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

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="app-shell">

      {/* ── Left rail ── */}
      <aside className="rail">
        <div className="rail-wordmark">openloops</div>

        {/* Pipeline actions */}
        <div className="rail-section">
          <div className="rail-eyebrow">Pipeline</div>

          <button className="rail-action" onClick={handleScan} disabled={scanning}>
            <span className="rail-action-label">
              {scanning ? "Scanning…" : "Scan my history"}
            </span>
            <span className="rail-action-count">
              {eventCount !== null && eventCount > 0
                ? `${eventCount.toLocaleString()} events` : "—"}
            </span>
          </button>

          <button
            className="rail-action"
            onClick={handleBuildSessions}
            disabled={buildingSessions || !eventCount}
          >
            <span className="rail-action-label">
              {buildingSessions ? "Building…" : "Build sessions"}
            </span>
            <span className="rail-action-count">
              {sessionCount !== null && sessionCount > 0
                ? `${sessionCount.toLocaleString()} sessions` : "—"}
            </span>
          </button>

          <button
            className="rail-action"
            onClick={handleBuildThreads}
            disabled={buildingThreads || !sessionCount}
          >
            <span className="rail-action-label">
              {buildingThreads ? "Building…" : "Build intent map"}
            </span>
            <span className="rail-action-count">
              {threadCount !== null && threadCount > 0
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
                className="rail-btn"
                onClick={handleSaveKey}
                disabled={!apiKey.trim() || keySaved}
              >
                {keySaved ? "Saved ✓" : "Save key"}
              </button>
              <button
                className="rail-btn rail-btn-accent"
                onClick={handleEnrichAndLabel}
                disabled={enriching || labeling || !keySaved || threads.length === 0}
              >
                {enriching ? "Enriching…" : labeling ? "Labeling…" : "Label & enrich"}
              </button>
            </div>
            {labelError && <p className="label-error">{labelError}</p>}
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
        <header className="app-header">
          <h1 className="app-title">openloops</h1>
          <p className="app-subtitle">the decisions you started and never closed</p>
        </header>

        {/* Intent map grouped by status */}
        <div className="intent-map">
          {threads.length === 0 ? (
            <p className="empty-state">
              Run the pipeline to see your intent threads.
            </p>
          ) : (
            statusGroups.map(({ status, items }) => {
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
                    {items.map((t) => <ThreadCard key={t.id} thread={t} brands={brands} />)}
                  </ul>
                </section>
              );
            })
          )}
        </div>

        {/* Pipeline detail — collapsible */}
        <div className="pipeline-detail">
          <div className="pipeline-detail-eyebrow">Pipeline Detail</div>

          <div className="collapsible-section">
            <button
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
    </div>
  );
}
