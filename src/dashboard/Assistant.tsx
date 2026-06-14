import { useEffect, useRef, useState } from "react";
import type { Brand, IntentThread } from "../types";

// Same model + headers as src/pipeline/label.ts — keep these in sync.
const MODEL = "claude-haiku-4-5-20251001";

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
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

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

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1024,
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
              {m.content}
            </div>
          ))
        )}
        {sending && <div className="assistant-thinking">thinking…</div>}
      </div>

      {error && <p className="label-error assistant-error">{error}</p>}

      {keySaved ? (
        <div className="assistant-input-row">
          <textarea
            className="assistant-input"
            placeholder="Ask about your open loops…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={sending}
            rows={2}
          />
          <button
            type="button"
            className="assistant-send-btn"
            onClick={() => void send(input)}
            disabled={sending || !input.trim()}
          >
            Send
          </button>
        </div>
      ) : (
        <p className="assistant-no-key">Add your Anthropic key above to chat.</p>
      )}

      <p className="assistant-privacy">
        Chats send your thread titles and summaries to Anthropic. Nothing else leaves your device.
      </p>
    </div>
  );
}
