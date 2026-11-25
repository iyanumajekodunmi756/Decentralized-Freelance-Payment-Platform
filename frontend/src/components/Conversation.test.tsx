/**
 * Conversation.test.tsx
 *
 * Issue #64: the job page's conversation view — it reads the thread, shows how
 * many messages were waiting, records the read receipt, and sends.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, act } from "@testing-library/react";

const ME = "GME";
const OTHER = "GOTHER";

const h = vi.hoisted(() => ({
  wallet: {
    publicKey: "GME" as string | null,
    connect: vi.fn(async () => "GME"),
    signMessage: vi.fn(async () => "sig"),
  },
  authenticate: vi.fn(async () => "jwt-1"),
  fetchMessages: vi.fn(),
  sendMessage: vi.fn(),
  markMessagesRead: vi.fn(async () => 0),
}));

vi.mock("../hooks/wallet-context", () => ({ useWallet: () => h.wallet }));
vi.mock("../lib/api", () => ({
  authenticate: h.authenticate,
  fetchMessages: h.fetchMessages,
  sendMessage: h.sendMessage,
  markMessagesRead: h.markMessagesRead,
}));

import Conversation from "./Conversation";

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: "m1",
    jobId: "job-1",
    senderId: "user-other",
    body: "The first milestone is ready for review",
    createdAt: "2026-01-02T03:04:05.000Z",
    readAt: null,
    sender: { stellarAddress: OTHER, displayName: null },
    ...overrides,
  };
}

beforeEach(() => {
  // jsdom does not implement scrolling; the auto-scroll effect calls this.
  Element.prototype.scrollIntoView = vi.fn();
  h.wallet.publicKey = ME;
  h.authenticate.mockClear();
  h.fetchMessages.mockReset();
  h.fetchMessages.mockResolvedValue([]);
  h.sendMessage.mockReset();
  h.markMessagesRead.mockReset();
  h.markMessagesRead.mockResolvedValue(0);
});

afterEach(() => cleanup());

describe("Conversation", () => {
  it("shows the thread and records a read receipt", async () => {
    h.fetchMessages.mockResolvedValue([message()]);

    render(<Conversation jobId="job-1" />);

    expect(await screen.findByText("The first milestone is ready for review")).toBeTruthy();
    await waitFor(() =>
      expect(h.markMessagesRead).toHaveBeenCalledWith("job-1", "jwt-1"),
    );
    expect(h.fetchMessages).toHaveBeenCalledWith("job-1", "jwt-1");
  });

  it("counts the other party's unread messages from before the receipt landed", async () => {
    h.fetchMessages.mockResolvedValue([
      message(),
      message({ id: "m2", sender: { stellarAddress: OTHER }, readAt: null }),
      // Already read, and a message I sent: neither is unread for me.
      message({ id: "m3", readAt: "2026-01-02T04:00:00.000Z" }),
      message({ id: "m4", sender: { stellarAddress: ME } }),
    ]);

    render(<Conversation jobId="job-1" />);

    expect(await screen.findByText("2 unread")).toBeTruthy();
  });

  it("shows no unread badge when nothing is waiting", async () => {
    h.fetchMessages.mockResolvedValue([message({ sender: { stellarAddress: ME } })]);

    render(<Conversation jobId="job-1" />);

    await screen.findByText("The first milestone is ready for review");
    expect(screen.queryByText(/unread/)).toBeNull();
  });

  describe("Redundant markMessagesRead prevention (Issue #254)", () => {
    it("does not call markMessagesRead when there are no unread counterparty messages", async () => {
      h.fetchMessages.mockResolvedValue([
        message({ id: "m1", sender: { stellarAddress: OTHER }, readAt: "2026-01-01T00:00:00.000Z", body: "Message from other" }),
        message({ id: "m2", sender: { stellarAddress: ME }, readAt: null, body: "Message from me" }),
      ]);

      render(<Conversation jobId="job-1" />);

      await screen.findByText("Message from other");
      expect(h.markMessagesRead).not.toHaveBeenCalled();
    });

    it("does not trigger markMessagesRead on polling cycles if no new unread messages arrived", async () => {
      vi.useFakeTimers();
      h.fetchMessages.mockResolvedValue([
        message({ id: "m1", sender: { stellarAddress: OTHER }, readAt: "2026-01-01T00:00:00.000Z", body: "Already read" }),
      ]);

      render(<Conversation jobId="job-1" />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(h.markMessagesRead).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });

      expect(h.markMessagesRead).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("triggers markMessagesRead during polling when a new unread counterparty message arrives", async () => {
      vi.useFakeTimers();
      h.fetchMessages.mockResolvedValueOnce([
        message({ id: "m1", sender: { stellarAddress: OTHER }, readAt: "2026-01-01T00:00:00.000Z", body: "Already read" }),
      ]);

      render(<Conversation jobId="job-1" />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(h.markMessagesRead).not.toHaveBeenCalled();

      h.fetchMessages.mockResolvedValueOnce([
        message({ id: "m1", sender: { stellarAddress: OTHER }, readAt: "2026-01-01T00:00:00.000Z", body: "Already read" }),
        message({ id: "m2", sender: { stellarAddress: OTHER }, readAt: null, body: "New unread message" }),
      ]);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });

      expect(h.markMessagesRead).toHaveBeenCalledTimes(1);
      expect(h.markMessagesRead).toHaveBeenCalledWith("job-1", "jwt-1");
      vi.useRealTimers();
    });
  });

  it("sends a message and shows it in the thread", async () => {
    h.fetchMessages.mockResolvedValue([]);
    h.sendMessage.mockResolvedValue(message({ id: "m9", body: "Starting on it now", senderId: "user-me" }));

    render(<Conversation jobId="job-1" />);
    await screen.findByText("No messages yet.");

    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Starting on it now" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(h.sendMessage).toHaveBeenCalledWith("job-1", "Starting on it now", "jwt-1"),
    );
    expect(await screen.findByText("Starting on it now")).toBeTruthy();
    // Attributed to the connected wallet, not to the respondent.
    expect(screen.getByText(/You ·/)).toBeTruthy();
  });

  it("refuses to send an empty message", async () => {
    h.fetchMessages.mockResolvedValue([]);

    render(<Conversation jobId="job-1" />);
    await screen.findByText("No messages yet.");

    // Whitespace only: the button stays disabled rather than posting a blank.
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "   " } });
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("surfaces a refusal (e.g. a third party) as an alert", async () => {
    h.fetchMessages.mockRejectedValue(new Error("Could not load the conversation (HTTP 403)"));

    render(<Conversation jobId="job-1" />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("HTTP 403");
  });

  it("asks a disconnected visitor to connect before showing the thread", async () => {
    h.wallet.publicKey = null;

    render(<Conversation jobId="job-1" />);

    expect(screen.getByRole("button", { name: "Connect a wallet" })).toBeTruthy();
    expect(h.fetchMessages).not.toHaveBeenCalled();
  });

  describe("Auto-scroll behavior (Issue #253)", () => {
    it("auto-scrolls on initial messages load", async () => {
      const scrollIntoViewMock = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoViewMock;
      h.fetchMessages.mockResolvedValue([message()]);

      render(<Conversation jobId="job-1" />);

      await screen.findByText("The first milestone is ready for review");
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: "smooth" });
    });

    it("auto-scrolls when user sends a new message", async () => {
      const scrollIntoViewMock = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoViewMock;
      h.fetchMessages.mockResolvedValue([message()]);
      h.sendMessage.mockResolvedValue(
        message({ id: "m2", body: "Here is my response", senderId: "user-me" }),
      );

      render(<Conversation jobId="job-1" />);
      await screen.findByText("The first milestone is ready for review");
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);

      fireEvent.change(screen.getByLabelText("Message"), {
        target: { value: "Here is my response" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));

      await screen.findByText("Here is my response");
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(2);
    });

    it("does not re-scroll on polling updates when message list is unchanged", async () => {
      const scrollIntoViewMock = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoViewMock;
      h.fetchMessages.mockResolvedValue([message()]);

      render(<Conversation jobId="job-1" />);

      await screen.findByText("The first milestone is ready for review");
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);

      vi.useFakeTimers();
      // Advance timers by poll interval (5000ms) with same messages
      await act(async () => {
        vi.advanceTimersByTime(5000);
      });
      vi.useRealTimers();

      // Still should only have been called once on initial load
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
    });

    it("does not auto-scroll on polling update when user is scrolled up reading history", async () => {
      const scrollIntoViewMock = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoViewMock;
      h.fetchMessages.mockResolvedValueOnce([message({ id: "m1" })]);

      const { container } = render(<Conversation jobId="job-1" />);
      await screen.findByText("The first milestone is ready for review");
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);

      // Simulate user scrolling up in the list container
      const listEl = container.querySelector(".message-list");
      if (listEl) {
        Object.defineProperty(listEl, "scrollHeight", { value: 1000, configurable: true });
        Object.defineProperty(listEl, "clientHeight", { value: 300, configurable: true });
        Object.defineProperty(listEl, "scrollTop", { value: 100, configurable: true }); // Scrolled far up (> 60px from bottom)
        fireEvent.scroll(listEl);
      }

      // Next poll returns a new message
      h.fetchMessages.mockResolvedValueOnce([
        message({ id: "m1" }),
        message({ id: "m2", body: "New polled message" }),
      ]);

      vi.useFakeTimers();
      await act(async () => {
        vi.advanceTimersByTime(5000);
      });
      vi.useRealTimers();

      // Should not have auto-scrolled because user is reading history
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("Real-time SSE Gateway (Issue #250)", () => {
    class MockEventSource {
      static instances: MockEventSource[] = [];
      url: string;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      close = vi.fn();

      constructor(url: string) {
        this.url = url;
        MockEventSource.instances.push(this);
      }
    }

    beforeEach(() => {
      MockEventSource.instances = [];
      vi.stubGlobal("EventSource", MockEventSource);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("connects to the SSE stream with authenticated token", async () => {
      h.fetchMessages.mockResolvedValue([]);

      render(<Conversation jobId="job-1" />);

      await waitFor(() => {
        expect(MockEventSource.instances.length).toBe(1);
        expect(MockEventSource.instances[0].url).toContain("/api/messages/job-1/stream?token=jwt-1");
      });
    });

    it("receives incoming messages via SSE in real time and marks counterparty message as read", async () => {
      h.fetchMessages.mockResolvedValue([]);

      render(<Conversation jobId="job-1" />);
      await screen.findByText("No messages yet.");

      await waitFor(() => {
        expect(MockEventSource.instances.length).toBe(1);
      });

      const sse = MockEventSource.instances[0];
      const incoming = message({
        id: "m-sse-1",
        body: "Real-time message delivered instantaneously",
        sender: { stellarAddress: OTHER },
      });

      act(() => {
        sse.onmessage?.(new MessageEvent("message", { data: JSON.stringify(incoming) }));
      });

      expect(await screen.findByText("Real-time message delivered instantaneously")).toBeTruthy();
      await waitFor(() => {
        expect(h.markMessagesRead).toHaveBeenCalledWith("job-1", "jwt-1");
      });
    });

    it("falls back gracefully when SSE fails without throwing an error", async () => {
      h.fetchMessages.mockResolvedValue([]);

      render(<Conversation jobId="job-1" />);
      await screen.findByText("No messages yet.");

      await waitFor(() => {
        expect(MockEventSource.instances.length).toBe(1);
      });

      const sse = MockEventSource.instances[0];
      act(() => {
        sse.onerror?.();
      });

      expect(sse.close).toHaveBeenCalled();
      // Conversation continues functioning normally
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });
});
