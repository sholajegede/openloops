import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { getAssistantModel, setAssistantModel, getAssistantEffort, setAssistantEffort } from "../lib/settings";
import type { Brand, IntentThread } from "../types";

// Default model — same as src/pipeline/label.ts. The user can pick a different
// one below; selection is persisted and used for every request.
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

const MODEL_OPTIONS: { id: string; label: string }[] = [
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5 — fastest" },
  { id: "claude-sonnet-4-6",          label: "Sonnet 4.6 — balanced" },
  { id: "claude-opus-4-6",            label: "Opus 4.6 — most capable" },
  { id: "claude-opus-4-7",            label: "Opus 4.7 — most capable" },
  { id: "claude-opus-4-8",            label: "Opus 4.8 — most capable" },
];

// "Effort" here is a simple proxy for response depth via max_tokens — the
// Messages API has no separate effort knob for these models.
const EFFORT_OPTIONS: { id: string; label: string; maxTokens: number }[] = [
  { id: "low",    label: "Low",    maxTokens: 512 },
  { id: "medium", label: "Medium", maxTokens: 1024 },
  { id: "high",   label: "High",   maxTokens: 2048 },
];
const DEFAULT_EFFORT = "medium";

const SYSTEM_INSTRUCTION =
  `You are the assistant inside "openloops", a browser extension that reconstructs ` +
  `the user's browsing history into "intent threads" — decisions, research, or ` +
  `plans they started and haven't closed. Help the user understand and act on ` +
  `these open loops. Be concrete: reference the actual threads by name and ` +
  `suggest real next actions. You are grounded only in the thread data provided ` +
  `below — if the user asks about something not present in it, say so plainly ` +
  `rather than guessing.`;

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
}

interface AssistantProps {
  threads: IntentThread[];
  brands: Map<string, Brand>;
  selectedThread: IntentThread | null;
  apiKey: string;
  keySaved: boolean;
  onClearFocus: () => void;
}

// ---------------------------------------------------------------------------
// Grounding context — built fresh per send so it always reflects current data
// ---------------------------------------------------------------------------

function buildGroundingContext(
  threads: IntentThread[],
  brands: Map<string, Brand>,
  selectedThread: IntentThread | null,
): string {
  if (!selectedThread) {
    const digest = threads
      .map((t) => {
        const domains = [...new Set(t.sessions.flatMap((s) => s.domains))].slice(0, 5).join(", ");
        return `- ${t.title} (${t.status}, ${t.type}): ${t.summary ?? "no summary yet"} | next: ${t.nextStep ?? "none"} | domains: ${domains || "none"}`;
      })
      .join("\n");

    return `${SYSTEM_INSTRUCTION}\n\nHere is a digest of all the user's open intent threads:\n${digest || "(no threads yet)"}`;
  }

  // Focused on one thread — give richer detail on it, plus a one-line list of others.
  const keywords = [...new Set(selectedThread.sessions.flatMap((s) => s.keywords))].slice(0, 10).join(", ");
  const domains = [...new Set(selectedThread.sessions.flatMap((s) => s.domains))].slice(0, 5);

  const domainLines = domains
    .map((d) => {
      const brand = brands.get(d);
      if (brand?.description) return `- ${d}: ${brand.name} — ${brand.description}`;
      return `- ${d}`;
    })
    .join("\n");

  const sampleTitles = [...new Set(selectedThread.sessions.flatMap((s) => s.events.map((e) => e.title)))]
    .slice(0, 20)
    .map((t) => `- ${t}`)
    .join("\n");

  const otherTitles = threads
    .filter((t) => t.id !== selectedThread.id)
    .map((t) => t.title)
    .join(", ");

  return `${SYSTEM_INSTRUCTION}

The user is focused on this thread:
Title: ${selectedThread.title}
Status: ${selectedThread.status}
Type: ${selectedThread.type}
Summary: ${selectedThread.summary ?? "none"}
Next step: ${selectedThread.nextStep ?? "none"}
Keywords: ${keywords || "none"}

Domains visited:
${domainLines || "(none)"}

Recent page titles:
${sampleTitles || "(none)"}

For context, the user's other open threads are: ${otherTitles || "none"}.`;
}

// ---------------------------------------------------------------------------
// Assistant
// ---------------------------------------------------------------------------

export default function Assistant({ threads, brands, selectedThread, apiKey, keySaved, onClearFocus }: AssistantProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [effort, setEffort] = useState(DEFAULT_EFFORT);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  useEffect(() => {
    void getAssistantModel().then((saved) => { if (saved) setModel(saved); });
    void getAssistantEffort().then((saved) => { if (saved) setEffort(saved); });
  }, []);

  function handleModelChange(id: string) {
    setModel(id);
    void setAssistantModel(id);
  }

  function handleEffortChange(id: string) {
    setEffort(id);
    void setAssistantEffort(id);
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    if (!keySaved) {
      setError("Add your Anthropic key above to chat.");
      return;
    }

    setError(null);
    const nextMessages: Message[] = [...messages, { role: "user", content: trimmed }];
    setMessages(nextMessages);
    setInput("");
    setSending(true);

    try {
      const systemPrompt = buildGroundingContext(threads, brands, selectedThread);
      const maxTokens = EFFORT_OPTIONS.find((e) => e.id === effort)?.maxTokens ?? 1024;

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: nextMessages.map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error("Invalid API key. Check your Anthropic API key and try again.");
        }
        throw new Error(`API request failed: ${response.status} ${response.statusText}`);
      }

      const data: { content: AnthropicContentBlock[] } = await response.json();
      const reply = data.content
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text)
        .join("");

      setMessages((prev) => [...prev, { role: "assistant", content: reply || "(empty response)" }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  }

  const suggestedPrompts = [
    "What should I close this week?",
    selectedThread ? "How do I finish this one?" : "Summarize my open loops",
    "What have I stalled on longest?",
  ];

  return (
    <div className="assistant">
      {selectedThread && (
        <div className="assistant-focus-header">
          <span className="assistant-focus-label">Focused: {selectedThread.title}</span>
          <button type="button" className="assistant-focus-clear" onClick={onClearFocus}>
            ✕
          </button>
        </div>
      )}

      <div className="assistant-messages" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="assistant-empty">
            <p className="assistant-empty-text">
              Ask about your open loops — what to close, where you left off.
            </p>
            <div className="assistant-chips">
              {suggestedPrompts.map((p) => (
                <button key={p} type="button" className="assistant-chip" onClick={() => void send(p)}>
                  {p}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`assistant-message assistant-message-${m.role}`}>
              {m.role === "assistant" ? (
                <ReactMarkdown>{m.content}</ReactMarkdown>
              ) : (
                m.content
              )}
            </div>
          ))
        )}
        {sending && <div className="assistant-thinking">thinking…</div>}
      </div>

      {error && <p className="label-error assistant-error">{error}</p>}

      <div className="assistant-composer">
        {keySaved ? (
          <textarea
            className="assistant-textarea"
            placeholder="Ask about your open loops…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={sending}
            rows={2}
          />
        ) : (
          <p className="assistant-no-key">Add your Anthropic key above to chat.</p>
        )}

        <div className="assistant-toolbar">
          <div className="assistant-toolbar-selects">
            <select
              className="assistant-select"
              value={model}
              onChange={(e) => handleModelChange(e.target.value)}
              aria-label="Model"
            >
              {MODEL_OPTIONS.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
            <select
              className="assistant-select"
              value={effort}
              onChange={(e) => handleEffortChange(e.target.value)}
              aria-label="Effort"
            >
              {EFFORT_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>{opt.label}</option>
              ))}
            </select>
          </div>

          {keySaved && (
            <button
              type="button"
              className="assistant-send-btn"
              onClick={() => void send(input)}
              disabled={sending || !input.trim()}
            >
              Send
            </button>
          )}
        </div>
      </div>

      <p className="assistant-privacy">
        Chats send your thread titles and summaries to Anthropic. Nothing else leaves your device.
      </p>
    </div>
  );
}
