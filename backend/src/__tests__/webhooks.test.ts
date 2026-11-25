import { describe, expect, it, vi } from "vitest";
import {
  computeWebhookSignature,
  deliverWebhookWithRetry,
  dispatchWebhooksForEvent,
  processPendingWebhookDeliveries,
  startWebhookRetryWorker,
  type WebhookStore,
} from "../lib/webhooks";

describe("Webhook delivery and signature (issue #313)", () => {
  const secret = "test-webhook-secret-key-12345";
  const payload = JSON.stringify({ event: "milestone.released", data: { escrowId: "123" } });

  it("computes an HMAC-SHA256 signature matching the payload and secret", () => {
    const signature = computeWebhookSignature(payload, secret);
    expect(signature).toBeDefined();
    expect(signature).toMatch(/^[0-9a-f]{64}$/);

    // Recomputing with same secret and payload is deterministic
    expect(computeWebhookSignature(payload, secret)).toBe(signature);

    // Different secret produces different signature
    expect(computeWebhookSignature(payload, "different-secret")).not.toBe(signature);
  });

  it("delivers payload with X-Signature-SHA256 header", async () => {
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = "";

    const mockFetch = vi.fn().mockImplementation(async (_url, options) => {
      capturedHeaders = options.headers;
      capturedBody = options.body;
      return { ok: true, status: 200, statusText: "OK" };
    });

    const result = await deliverWebhookWithRetry(
      "https://example.com/webhook",
      payload,
      secret,
      "milestone.released",
      {
        fetchFn: mockFetch as unknown as typeof fetch,
        initialDelayMs: 1,
      },
    );

    expect(result.success).toBe(true);
    expect(result.attempt).toBe(1);
    expect(capturedHeaders["X-Signature-SHA256"]).toBe(computeWebhookSignature(payload, secret));
    expect(capturedHeaders["Content-Type"]).toBe("application/json");
    expect(capturedHeaders["X-Freelance-Event"]).toBe("milestone.released");
    expect(capturedBody).toBe(payload);
  });

  it("retries delivery with exponential backoff on HTTP 500 error", async () => {
    let attempts = 0;
    const delays: number[] = [];

    const mockFetch = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts < 3) {
        return { ok: false, status: 500, statusText: "Internal Server Error" };
      }
      return { ok: true, status: 200, statusText: "OK" };
    });

    const mockSleep = vi.fn().mockImplementation(async (ms: number) => {
      delays.push(ms);
    });

    const result = await deliverWebhookWithRetry(
      "https://example.com/webhook",
      payload,
      secret,
      "milestone.released",
      {
        fetchFn: mockFetch as unknown as typeof fetch,
        sleepFn: mockSleep,
        maxRetries: 3,
        initialDelayMs: 100,
        backoffFactor: 2,
      },
    );

    expect(result.success).toBe(true);
    expect(result.attempt).toBe(3);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([100, 200]);
  });

  it("fails after exceeding maxRetries on persistent network error", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network connection reset"));
    const delays: number[] = [];
    const mockSleep = vi.fn().mockImplementation(async (ms: number) => {
      delays.push(ms);
    });

    const result = await deliverWebhookWithRetry(
      "https://example.com/webhook",
      payload,
      secret,
      "job.funded",
      {
        fetchFn: mockFetch as unknown as typeof fetch,
        sleepFn: mockSleep,
        maxRetries: 3,
        initialDelayMs: 50,
        backoffFactor: 2,
      },
    );

    expect(result.success).toBe(false);
    expect(result.attempt).toBe(3);
    expect(result.error).toContain("Network connection reset");
    expect(delays).toEqual([50, 100]);
  });

  it("dispatches events only to active subscriptions that match the event type or '*'", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    const mockStore: WebhookStore = {
      webhookSubscription: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "sub-1",
            url: "https://service-a.com/hook",
            secret: "sec1",
            events: ["*"],
            isActive: true,
          },
          {
            id: "sub-2",
            url: "https://service-b.com/hook",
            secret: "sec2",
            events: ["dispute_opened"],
            isActive: true,
          },
          {
            id: "sub-3",
            url: "https://service-c.com/hook",
            secret: "sec3",
            events: ["milestone_released"],
            isActive: true,
          },
        ]),
      },
    };

    // Dispatch milestone_released: should match sub-1 (*) and sub-3 (milestone_released), but not sub-2
    await dispatchWebhooksForEvent(
      "milestone_released",
      { escrowId: "101", amount: "500" },
      mockStore,
      {
        fetchFn: mockFetch as unknown as typeof fetch,
        initialDelayMs: 1,
      },
    );

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const calledUrls = mockFetch.mock.calls.map((call) => call[0]);
    expect(calledUrls).toContain("https://service-a.com/hook");
    expect(calledUrls).toContain("https://service-c.com/hook");
    expect(calledUrls).not.toContain("https://service-b.com/hook");
  });

  describe("Automated webhook retry worker and dead-letter queue (issue #379)", () => {
    it("records failed webhook deliveries into store with status PENDING_RETRY", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 502, statusText: "Bad Gateway" });
      const createdDeliveries: any[] = [];

      const mockStore: WebhookStore = {
        webhookSubscription: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "sub-fail-1",
              url: "https://downstream-service.example/webhook",
              secret: "sec-retry",
              events: ["*"],
              isActive: true,
            },
          ]),
        },
        webhookDelivery: {
          create: vi.fn().mockImplementation(async (args) => {
            createdDeliveries.push(args.data);
            return { id: "del-1", ...args.data };
          }),
          findMany: vi.fn(),
          update: vi.fn(),
        },
      };

      await dispatchWebhooksForEvent(
        "escrow.funded",
        { escrowId: "200" },
        mockStore,
        {
          fetchFn: mockFetch as unknown as typeof fetch,
          maxRetries: 2,
          initialDelayMs: 1,
        },
      );

      expect(mockStore.webhookDelivery?.create).toHaveBeenCalledTimes(1);
      expect(createdDeliveries).toHaveLength(1);
      expect(createdDeliveries[0].status).toBe("PENDING_RETRY");
      expect(createdDeliveries[0].subscriptionId).toBe("sub-fail-1");
      expect(createdDeliveries[0].attempts).toBe(2);
      expect(createdDeliveries[0].responseCode).toBe(502);
      expect(createdDeliveries[0].nextRetryAt).toBeInstanceOf(Date);
    });

    it("retries pending deliveries and updates status to SUCCESS when delivery succeeds", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK" });
      const updatedDeliveries: any[] = [];

      const mockStore: WebhookStore = {
        webhookDelivery: {
          create: vi.fn(),
          findMany: vi.fn().mockResolvedValue([
            {
              id: "del-pending-1",
              url: "https://recovering-service.example/webhook",
              secret: "secret-recover",
              event: "milestone.approved",
              payload: JSON.stringify({ event: "milestone.approved" }),
              status: "PENDING_RETRY",
              attempts: 2,
              maxAttempts: 5,
              nextRetryAt: new Date(Date.now() - 5000),
            },
          ]),
          update: vi.fn().mockImplementation(async (args) => {
            updatedDeliveries.push(args);
            return args;
          }),
        },
      };

      const result = await processPendingWebhookDeliveries(mockStore, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(result.processed).toBe(1);
      expect(result.succeeded).toBe(1);
      expect(result.deadLettered).toBe(0);
      expect(mockStore.webhookDelivery?.update).toHaveBeenCalledWith({
        where: { id: "del-pending-1" },
        data: expect.objectContaining({
          status: "SUCCESS",
          attempts: 3,
          responseCode: 200,
        }),
      });
    });

    it("transitions exhausted deliveries to DEAD_LETTER after exceeding maxAttempts", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 504, statusText: "Gateway Timeout" });
      const updatedDeliveries: any[] = [];

      const mockStore: WebhookStore = {
        webhookDelivery: {
          create: vi.fn(),
          findMany: vi.fn().mockResolvedValue([
            {
              id: "del-exhausted-1",
              url: "https://dead-service.example/webhook",
              secret: "secret-dead",
              event: "dispute.resolved",
              payload: JSON.stringify({ event: "dispute.resolved" }),
              status: "PENDING_RETRY",
              attempts: 4,
              maxAttempts: 5,
              nextRetryAt: new Date(Date.now() - 10000),
            },
          ]),
          update: vi.fn().mockImplementation(async (args) => {
            updatedDeliveries.push(args);
            return args;
          }),
        },
      };

      const result = await processPendingWebhookDeliveries(mockStore, {
        fetchFn: mockFetch as unknown as typeof fetch,
        maxAttempts: 5,
      });

      expect(result.processed).toBe(1);
      expect(result.deadLettered).toBe(1);
      expect(result.succeeded).toBe(0);
      expect(mockStore.webhookDelivery?.update).toHaveBeenCalledWith({
        where: { id: "del-exhausted-1" },
        data: expect.objectContaining({
          status: "DEAD_LETTER",
          attempts: 5,
          responseCode: 504,
        }),
      });
    });

    it("starts and stops background retry worker handle cleanly", async () => {
      const mockStore: WebhookStore = {
        webhookDelivery: {
          create: vi.fn(),
          findMany: vi.fn().mockResolvedValue([]),
          update: vi.fn(),
        },
      };

      const worker = startWebhookRetryWorker({
        store: mockStore,
        intervalMs: 10000,
      });

      expect(worker.stop).toBeInstanceOf(Function);
      expect(worker.processOnce).toBeInstanceOf(Function);

      const runResult = await worker.processOnce();
      expect(runResult.processed).toBe(0);

      worker.stop();
    });
  });

});
