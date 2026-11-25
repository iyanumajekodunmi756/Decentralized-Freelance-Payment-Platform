/**
 * Conversation.tsx
 *
 * The job-scoped conversation between a job's client and its freelancer,
 * rendered on the job page (issue #64).
 *
 * Contributor Notes:
 * - `jobId` is the *off-chain* job id: the API scopes messages to it, while the
 *   job page is keyed by the on-chain escrow id. The page resolves one to the
 *   other and only mounts this component for a participant.
 * - Opening the thread marks the other party's messages read, so the unread
 *   counts elsewhere drop. The count shown in the heading is captured *before*
 *   that receipt lands — otherwise it would always read zero.
 * - Only a participant ever reaches the API here; the server enforces the same
 *   rule, so the check is a courtesy, not the boundary.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  authenticate,
  fetchMessages,
  markMessagesRead,
  sendMessage,
  type MessageApi,
} from "../lib/api";
import { shortAddress } from "../lib/address";
import { useWallet } from "../hooks/wallet-context";

const MAX_BODY = 2000;
const POLL_INTERVAL_MS = 5000; // Poll for new messages every 5 seconds

export default function Conversation({ jobId }: { jobId: string }) {
  const { publicKey, connect, signMessage } = useWallet();
  const [messages, setMessages] = useState<MessageApi[]>([]);
  /** How many of the other party's messages were waiting when the thread opened. */
  const [unreadAtOpen, setUnreadAtOpen] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const initialScrollDoneRef = useRef(false);
  const userSentMessageRef = useRef(false);
  const prevMessageIdsRef = useRef<string>("");
  const initialLoadDoneRef = useRef(false);

  useEffect(() => {
    initialLoadDoneRef.current = false;
  }, [jobId, publicKey]);

  const checkIfAtBottom = useCallback(() => {
    if (listRef.current && listRef.current.scrollHeight > listRef.current.clientHeight) {
      const { scrollTop, scrollHeight, clientHeight } = listRef.current;
      isAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 60;
    } else {
      const windowScrollTop = window.scrollY || document.documentElement.scrollTop;
      const windowScrollHeight = document.documentElement.scrollHeight;
      const windowClientHeight = window.innerHeight || document.documentElement.clientHeight;
      isAtBottomRef.current = windowScrollHeight - windowScrollTop - windowClientHeight < 60;
    }
  }, []);

  useEffect(() => {
    const container = listRef.current;
    window.addEventListener("scroll", checkIfAtBottom, { passive: true });
    container?.addEventListener("scroll", checkIfAtBottom, { passive: true });
    return () => {
      window.removeEventListener("scroll", checkIfAtBottom);
      container?.removeEventListener("scroll", checkIfAtBottom);
    };
  }, [checkIfAtBottom]);

  const load = useCallback(async () => {
    if (!publicKey) return;
    setLoading(true);
    setError(null);
    try {
      const token = await authenticate(publicKey, signMessage);
      const list = await fetchMessages(jobId, token);
      const unreadCount = list.filter(
        (m) => m.sender?.stellarAddress !== publicKey && m.readAt === null,
      ).length;

      if (!initialLoadDoneRef.current) {
        setUnreadAtOpen(unreadCount);
        initialLoadDoneRef.current = true;
      }

      if (unreadCount > 0) {
        await markMessagesRead(jobId, token);
        const now = new Date().toISOString();
        setMessages(
          list.map((m) =>
            m.sender?.stellarAddress !== publicKey && m.readAt === null
              ? { ...m, readAt: now }
              : m,
          ),
        );
      } else {
        setMessages(list);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [jobId, publicKey, signMessage]);

  useEffect(() => {
    void load();
  }, [load]);

  // Auto-scroll logic (issue #253):
  // 1. Auto-scroll on initial mount when messages are first loaded.
  // 2. Auto-scroll when the user actively sends a message.
  // 3. For polling updates: only scroll if the user is already at the bottom and new messages arrived.
  // 4. Do not re-scroll if polling returns unchanged message list.
  useEffect(() => {
    if (messages.length === 0 || !messagesEndRef.current) return;

    const currentIds = messages.map((m) => m.id).join(",");
    const messagesChanged = currentIds !== prevMessageIdsRef.current;
    prevMessageIdsRef.current = currentIds;

    if (!messagesChanged && initialScrollDoneRef.current) {
      return;
    }

    const shouldScroll =
      !initialScrollDoneRef.current ||
      userSentMessageRef.current ||
      isAtBottomRef.current;

    if (shouldScroll) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
      isAtBottomRef.current = true;
    }

    initialScrollDoneRef.current = true;
    userSentMessageRef.current = false;
  }, [messages]);

  // Real-time chat message stream (issue #250: SSE gateway with polling fallback)
  useEffect(() => {
    if (!publicKey || typeof EventSource === "undefined") return;

    let eventSource: EventSource | null = null;
    let isCancelled = false;

    async function initStream() {
      try {
        const token = await authenticate(publicKey!, signMessage);
        if (isCancelled) return;

        const url = `/api/messages/${encodeURIComponent(jobId)}/stream?token=${encodeURIComponent(token)}`;
        eventSource = new EventSource(url);

        eventSource.onmessage = (event) => {
          try {
            const newMsg = JSON.parse(event.data) as MessageApi;
            if (!newMsg || !newMsg.id) return;

            setMessages((prev) => {
              if (prev.some((m) => m.id === newMsg.id)) return prev;
              return [...prev, newMsg];
            });

            if (newMsg.sender?.stellarAddress !== publicKey) {
              void markMessagesRead(jobId, token);
            }
          } catch {
            // Ignore malformed event payload
          }
        };

        eventSource.onerror = () => {
          // Close on error; polling provides uninterrupted fallback
          eventSource?.close();
        };
      } catch {
        // Fall back to polling
      }
    }

    void initStream();

    return () => {
      isCancelled = true;
      eventSource?.close();
    };
  }, [jobId, publicKey, signMessage]);

  // Poll for new messages every 5 seconds
  useEffect(() => {
    if (!publicKey) return;

    const pollInterval = setInterval(() => {
      void load();
    }, POLL_INTERVAL_MS);

    return () => clearInterval(pollInterval);
  }, [publicKey, load]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!publicKey || text.length === 0 || sending) return;

    setSending(true);
    setError(null);
    try {
      const token = await authenticate(publicKey, signMessage);
      const sent = await sendMessage(jobId, text, token);
      // The response carries the row but not its sender relation, so tag it here
      // rather than refetching the whole conversation.
      userSentMessageRef.current = true;
      setMessages((prev) => [...prev, { ...sent, sender: { stellarAddress: publicKey } }]);
      setDraft("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="conversation">
      <h2>
        Messages{" "}
        {unreadAtOpen > 0 && (
          <span className="badge badge-active">{unreadAtOpen} unread</span>
        )}
      </h2>

      {!publicKey ? (
        <p>
          <button onClick={() => void connect()}>Connect a wallet</button> to read and
          send messages.
        </p>
      ) : (
        <>
          {error && (
            <p role="alert" className="alert alert-error">
              {error}
            </p>
          )}

          {loading && messages.length === 0 && <p className="muted">Loading messages…</p>}
          {!loading && messages.length === 0 && !error && (
            <p className="muted">No messages yet.</p>
          )}

          {messages.length > 0 && (
            <ol className="message-list" ref={listRef}>
              {messages.map((message) => {
                const mine = message.sender?.stellarAddress === publicKey;
                return (
                  <li key={message.id} className={mine ? "message message-mine" : "message"}>
                    <span className="muted">
                      {mine
                        ? "You"
                        : shortAddress(
                            message.sender?.stellarAddress ?? "The other participant",
                          )}{" "}
                      · <time dateTime={message.createdAt}>
                        {new Date(message.createdAt).toLocaleString()}
                      </time>
                    </span>
                    <p>{message.body}</p>
                  </li>
                );
              })}
              <div ref={messagesEndRef} />
            </ol>
          )}

          <form onSubmit={handleSend}>
            <label>
              Message
              <br />
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={MAX_BODY}
                rows={2}
                cols={60}
                placeholder="Ask about the work…"
              />
            </label>
            <button type="submit" disabled={sending || draft.trim().length === 0}>
              {sending ? "Sending…" : "Send"}
            </button>
          </form>
        </>
      )}
    </section>
  );
}
