// Shared TypeScript interfaces for the Signal pipeline.
// Each stage of the pipeline consumes and produces these types.

export interface RawEvent {
  id: string;
  url: string;
  domain: string;
  title: string;
  visitedAt: number;         // epoch ms
  source: "backfill" | "live";
}

export interface Session {
  id: string;
  events: RawEvent[];
  startedAt: number;
  endedAt: number;
  domains: string[];
  keywords: string[];
}

export interface IntentThread {
  id: string;
  title: string;
  summary?: string;
  nextStep?: string;   // one concrete action to move the thread forward (Phase 7a)
  sessions: Session[];
  type: "buying" | "research" | "planning" | "learning" | "unclassified";
  confidence: number;        // 0-1
  status: "active" | "stalled" | "dormant";
  firstSeen: number;
  lastSeen: number;
  distinctDays: number;
  signals: string[];
}

export interface Brand {
  domain: string;
  name: string;
  description: string;
  industry: string;
  logoUrl: string;
  brandColor: string;
}
