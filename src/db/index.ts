import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { RawEvent, Session, IntentThread, Brand } from "../types";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Typed schema for the "signal" database.
 * To add a store in a future phase:
 *   1. Add it to this interface.
 *   2. Bump DB_VERSION.
 *   3. Add createObjectStore inside the upgrade callback, guarded by
 *      `if (!db.objectStoreNames.contains(...))` so existing users upgrade
 *      safely without touching stores that already exist.
 */
interface OpenloopsDB extends DBSchema {
  raw_events: {
    key: string;
    value: RawEvent;
    indexes: { by_visitedAt: number };
  };
  sessions: {
    key: string;
    value: Session;
    indexes: { by_startedAt: number };
  };
  intent_threads: {
    key: string;
    value: IntentThread;
    indexes: { by_lastSeen: number };
  };
  domain_brands: {
    key: string;
    value: Brand;
  };
}

const DB_NAME = "openloops";
const DB_VERSION = 4;

// ---------------------------------------------------------------------------
// Connection (singleton promise — safe to call from any module)
// ---------------------------------------------------------------------------

let _db: Promise<IDBPDatabase<OpenloopsDB>> | null = null;

export function getDB(): Promise<IDBPDatabase<OpenloopsDB>> {
  if (!_db) {
    _db = openDB<OpenloopsDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        // Phase 1 store
        if (!db.objectStoreNames.contains("raw_events")) {
          const s = db.createObjectStore("raw_events", { keyPath: "id" });
          s.createIndex("by_visitedAt", "visitedAt");
        }
        // Phase 3 store
        if (!db.objectStoreNames.contains("sessions")) {
          const s = db.createObjectStore("sessions", { keyPath: "id" });
          s.createIndex("by_startedAt", "startedAt");
        }
        // Phase 4 store
        if (!db.objectStoreNames.contains("intent_threads")) {
          const s = db.createObjectStore("intent_threads", { keyPath: "id" });
          s.createIndex("by_lastSeen", "lastSeen");
        }
        // Pass 3 store
        if (!db.objectStoreNames.contains("domain_brands")) {
          db.createObjectStore("domain_brands", { keyPath: "domain" });
        }
      },
    });
  }
  return _db;
}

// ---------------------------------------------------------------------------
// raw_events helpers
// ---------------------------------------------------------------------------

/** Wipe all raw events (called at the start of each backfill for a clean snapshot). */
export async function clearEvents(): Promise<void> {
  const db = await getDB();
  return db.clear("raw_events");
}

/** Write (or overwrite) a batch of RawEvents. Idempotent via IDB put. */
export async function putEvents(events: RawEvent[]): Promise<void> {
  if (events.length === 0) return;
  const db = await getDB();
  const tx = db.transaction("raw_events", "readwrite");
  await Promise.all([...events.map((e) => tx.store.put(e)), tx.done]);
}

/** Every raw event, sorted by visitedAt ascending (index natural order). */
export async function getAllEvents(): Promise<RawEvent[]> {
  const db = await getDB();
  return db.getAllFromIndex("raw_events", "by_visitedAt");
}

/** Total number of raw events stored. */
export async function getEventCount(): Promise<number> {
  const db = await getDB();
  return db.count("raw_events");
}

/** Up to `limit` events sorted by visitedAt descending (most recent first). */
export async function getRecentEvents(limit: number): Promise<RawEvent[]> {
  const db = await getDB();
  const index = db
    .transaction("raw_events", "readonly")
    .store.index("by_visitedAt");

  let cursor = await index.openCursor(null, "prev");
  const results: RawEvent[] = [];
  while (cursor && results.length < limit) {
    results.push(cursor.value);
    cursor = await cursor.continue();
  }
  return results;
}

// ---------------------------------------------------------------------------
// sessions helpers
// ---------------------------------------------------------------------------

/** Write (or overwrite) a batch of Sessions. Idempotent via IDB put. */
export async function putSessions(sessions: Session[]): Promise<void> {
  if (sessions.length === 0) return;
  const db = await getDB();
  const tx = db.transaction("sessions", "readwrite");
  await Promise.all([...sessions.map((s) => tx.store.put(s)), tx.done]);
}

/** Wipe all sessions (called before a rebuild so results are idempotent). */
export async function clearSessions(): Promise<void> {
  const db = await getDB();
  return db.clear("sessions");
}

/** Every session, sorted by startedAt ascending (index natural order). */
export async function getAllSessions(): Promise<Session[]> {
  const db = await getDB();
  return db.getAllFromIndex("sessions", "by_startedAt");
}

/** Total number of sessions stored. */
export async function getSessionCount(): Promise<number> {
  const db = await getDB();
  return db.count("sessions");
}

// ---------------------------------------------------------------------------
// intent_threads helpers
// ---------------------------------------------------------------------------

/** Write (or overwrite) a batch of IntentThreads. Idempotent via IDB put. */
export async function putThreads(threads: IntentThread[]): Promise<void> {
  if (threads.length === 0) return;
  const db = await getDB();
  const tx = db.transaction("intent_threads", "readwrite");
  await Promise.all([...threads.map((t) => tx.store.put(t)), tx.done]);
}

/** Wipe all intent threads (called before a rebuild). */
export async function clearThreads(): Promise<void> {
  const db = await getDB();
  return db.clear("intent_threads");
}

/**
 * Every thread sorted by lastSeen descending (most recently active first).
 * Uses a reverse cursor on the by_lastSeen index.
 */
export async function getAllThreads(): Promise<IntentThread[]> {
  const db = await getDB();
  const index = db
    .transaction("intent_threads", "readonly")
    .store.index("by_lastSeen");

  let cursor = await index.openCursor(null, "prev");
  const results: IntentThread[] = [];
  while (cursor) {
    results.push(cursor.value);
    cursor = await cursor.continue();
  }
  return results;
}

/** Total number of intent threads stored. */
export async function getThreadCount(): Promise<number> {
  const db = await getDB();
  return db.count("intent_threads");
}

// ---------------------------------------------------------------------------
// domain_brands helpers
// ---------------------------------------------------------------------------

/** Retrieve a cached brand record by domain, or undefined if not yet fetched. */
export async function getBrand(domain: string): Promise<Brand | undefined> {
  const db = await getDB();
  return db.get("domain_brands", domain);
}

/** Write (or overwrite) a batch of Brand records. Idempotent via IDB put. */
export async function putBrands(brands: Brand[]): Promise<void> {
  if (brands.length === 0) return;
  const db = await getDB();
  const tx = db.transaction("domain_brands", "readwrite");
  await Promise.all([...brands.map((b) => tx.store.put(b)), tx.done]);
}

/** Every cached brand record. */
export async function getAllBrands(): Promise<Brand[]> {
  const db = await getDB();
  return db.getAll("domain_brands");
}

/** Set of all domain names already resolved and cached. */
export async function getCachedDomains(): Promise<Set<string>> {
  const db = await getDB();
  const keys = await db.getAllKeys("domain_brands");
  return new Set(keys);
}

/** Wipe all cached brand records. */
export async function clearBrands(): Promise<void> {
  const db = await getDB();
  return db.clear("domain_brands");
}
