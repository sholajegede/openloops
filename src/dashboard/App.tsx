import { useEffect, useState } from "react";
import { backfillHistory } from "../pipeline/backfill";
import { buildSessions } from "../pipeline/sessions";
import { buildThreads } from "../pipeline/threads";
import { labelThreads } from "../pipeline/label";
import { getApiKey, setApiKey } from "../lib/settings";
import {
  getEventCount,
  getRecentEvents,
  getAllSessions,
  getSessionCount,
  getAllThreads,
  getThreadCount,
} from "../db/index";
import type { RawEvent, Session, IntentThread } from "../types";

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
// Type badge and status pill metadata
// ---------------------------------------------------------------------------

const TYPE_COLORS: Record<IntentThread["type"], string> = {
  buying:       "#d97706",
  learning:     "#0891b2",
  research:     "#7c3aed",
  planning:     "#059669",
  unclassified: "#525252",
};

const STATUS_COLORS: Record<IntentThread["status"], string> = {
  active:  "#16a34a",
  stalled: "#ca8a04",
  dormant: "#525252",
};

// ---------------------------------------------------------------------------
// Thread card
// ---------------------------------------------------------------------------

function ThreadCard({ thread }: { thread: IntentThread }) {
  const totalEvents = thread.sessions.reduce((n, s) => n + s.events.length, 0);
  const topDomains  = [...new Set(thread.sessions.flatMap((s) => s.domains))].slice(0, 4);

  return (
    <li className="thread-card">
      {/* ── Title row ── */}
      <div className="thread-header">
        <h3 className="thread-title">{thread.title}</h3>
        <div className="thread-badges">
          <span
            className="badge type-badge"
            style={{ background: TYPE_COLORS[thread.type] + "22", color: TYPE_COLORS[thread.type] }}
          >
            {thread.type}
          </span>
          <span
            className="badge status-badge"
            style={{ background: STATUS_COLORS[thread.status] + "22", color: STATUS_COLORS[thread.status] }}
          >
            {thread.status}
          </span>
        </div>
      </div>

      {thread.summary && <p className="thread-summary">{thread.summary}</p>}

      {/* ── Confidence bar ── */}
      <div className="confidence-row">
        <div className="confidence-bar-track">
          <div
            className="confidence-bar-fill"
            style={{ width: `${thread.confidence * 100}%` }}
          />
        </div>
        <span className="confidence-pct">{Math.round(thread.confidence * 100)}%</span>
      </div>

      {/* ── Stats row ── */}
      <div className="thread-stats">
        <span>{thread.sessions.length} session{thread.sessions.length !== 1 ? "s" : ""}</span>
        <span>·</span>
        <span>{totalEvents} events</span>
        <span>·</span>
        <span>{thread.distinctDays} day{thread.distinctDays !== 1 ? "s" : ""}</span>
        <span>·</span>
        <span>{relativeTime(thread.lastSeen)}</span>
      </div>

      {/* ── Domains ── */}
      <div className="thread-domains">
        {topDomains.map((d) => (
          <span key={d} className="session-domain">{d}</span>
        ))}
      </div>

      {/* ── Keywords ── */}
      {thread.sessions.flatMap((s) => s.keywords).length > 0 && (
        <div className="keyword-tags">
          {[...new Set(thread.sessions.flatMap((s) => s.keywords))].slice(0, 8).map((kw) => (
            <span key={kw} className="keyword-tag">{kw}</span>
          ))}
        </div>
      )}

      {/* ── Signals (why) ── */}
      <ul className="signals-list">
        {thread.signals.map((sig) => (
          <li key={sig} className="signal-item">{sig}</li>
        ))}
      </ul>
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
// Main component
// ---------------------------------------------------------------------------

export default function App() {
  // Raw events
  const [eventCount, setEventCount]   = useState<number | null>(null);
  const [recentEvents, setRecentEvents] = useState<RawEvent[]>([]);
  const [scanning, setScanning]       = useState(false);

  // Sessions
  const [sessionCount, setSessionCount]           = useState<number | null>(null);
  const [sessions, setSessions]                   = useState<Session[]>([]);
  const [filteredEventCount, setFilteredEventCount] = useState<number | null>(null);
  const [buildingSessions, setBuildingSessions]   = useState(false);

  // Threads
  const [threadCount, setThreadCount] = useState<number | null>(null);
  const [threads, setThreads]         = useState<IntentThread[]>([]);
  const [buildingThreads, setBuildingThreads] = useState(false);

  // AI labeling (Phase 6)
  const [apiKey, setApiKeyState]   = useState("");
  const [keySaved, setKeySaved]    = useState(false);
  const [labeling, setLabeling]    = useState(false);
  const [labelError, setLabelError] = useState<string | null>(null);

  useEffect(() => {
    void refreshAll();
    void getApiKey().then((saved) => {
      if (saved) { setApiKeyState(saved); setKeySaved(true); }
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
    setThreads(sortedThreads(allThreads));
  }

  function sortedThreads(raw: IntentThread[]): IntentThread[] {
    const order = { active: 0, stalled: 1, dormant: 2 };
    return [...raw].sort((a, b) => {
      const byStatus = order[a.status] - order[b.status];
      return byStatus !== 0 ? byStatus : b.confidence - a.confidence;
    });
  }

  async function handleScan() {
    setScanning(true);
    try {
      await backfillHistory(14);
      await refreshAll();
    } finally {
      setScanning(false);
    }
  }

  async function handleBuildSessions() {
    setBuildingSessions(true);
    try {
      const result = await buildSessions();
      setFilteredEventCount(result.events);
      const allSessions = await getAllSessions();
      setSessionCount(allSessions.length);
      setSessions([...allSessions].reverse());
    } finally {
      setBuildingSessions(false);
    }
  }

  async function handleBuildThreads() {
    setBuildingThreads(true);
    try {
      const result = await buildThreads();
      setThreadCount(result.threads);
      const allThreads = await getAllThreads();
      setThreads(sortedThreads(allThreads));
    } finally {
      setBuildingThreads(false);
    }
  }

  async function handleSaveKey() {
    await setApiKey(apiKey.trim());
    setKeySaved(true);
    setLabelError(null);
  }

  async function handleLabel() {
    setLabeling(true);
    setLabelError(null);
    try {
      await labelThreads(apiKey.trim());
      const allThreads = await getAllThreads();
      setThreads(sortedThreads(allThreads));
    } catch (err) {
      setLabelError(err instanceof Error ? err.message : "Labeling failed.");
    } finally {
      setLabeling(false);
    }
  }

  return (
    <main className="app">
      <header className="app-header">
        <h1 className="app-title">openloops</h1>
        <p className="app-subtitle">the decisions you started and never closed</p>
      </header>

      {/* ── Intent map (above sessions) ── */}
      <section className="pipeline-section">
        <div className="pipeline-header">
          <div>
            <h2 className="section-heading" style={{ marginBottom: 4 }}>Intent Map</h2>
            {threadCount !== null && threadCount > 0 && (
              <p className="pipeline-summary">{threadCount} thread{threadCount !== 1 ? "s" : ""} detected</p>
            )}
          </div>
          <button
            className="action-btn"
            onClick={handleBuildThreads}
            disabled={buildingThreads || !sessionCount}
          >
            {buildingThreads ? "Building…" : "Build intent map"}
          </button>
        </div>

        {/* ── AI labeling (opt-in) ── */}
        <div className="api-key-row">
          <input
            className="api-key-input"
            type="password"
            placeholder="Anthropic API key (sk-ant-…)"
            value={apiKey}
            onChange={(e) => { setApiKeyState(e.target.value); setKeySaved(false); }}
          />
          <button
            className="action-btn"
            onClick={handleSaveKey}
            disabled={!apiKey.trim() || keySaved}
          >
            {keySaved ? "Saved" : "Save key"}
          </button>
          <button
            className="action-btn"
            onClick={handleLabel}
            disabled={labeling || !keySaved || threads.length === 0}
          >
            {labeling ? "Labeling…" : "Label with AI"}
          </button>
        </div>
        {labelError && <p className="label-error">{labelError}</p>}

        {threads.length > 0 && (
          <ul className="thread-list">
            {threads.map((t) => <ThreadCard key={t.id} thread={t} />)}
          </ul>
        )}
      </section>

      {/* ── Sessions ── */}
      <section className="pipeline-section">
        <div className="pipeline-header">
          <div>
            <h2 className="section-heading" style={{ marginBottom: 4 }}>Sessions</h2>
            {filteredEventCount !== null && sessionCount !== null && sessionCount > 0 && (
              <p className="pipeline-summary">
                {filteredEventCount.toLocaleString()} events → {sessionCount.toLocaleString()} sessions
              </p>
            )}
          </div>
          <button
            className="action-btn"
            onClick={handleBuildSessions}
            disabled={buildingSessions || !eventCount}
          >
            {buildingSessions ? "Building…" : "Build sessions"}
          </button>
        </div>

        {sessions.length > 0 && (
          <ul className="session-list">
            {sessions.map((s) => <SessionRow key={s.id} session={s} />)}
          </ul>
        )}
      </section>

      {/* ── Raw events ── */}
      <section className="pipeline-section">
        <div className="pipeline-header">
          <div>
            <h2 className="section-heading" style={{ marginBottom: 4 }}>Raw Events</h2>
            {eventCount !== null && (
              <p className="pipeline-summary">
                {eventCount.toLocaleString()} events captured
              </p>
            )}
          </div>
          <button className="action-btn" onClick={handleScan} disabled={scanning}>
            {scanning ? "Scanning…" : "Scan my history"}
          </button>
        </div>

        {recentEvents.length > 0 && (
          <>
            <h3 className="subsection-heading">20 most recent</h3>
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
      </section>
    </main>
  );
}
