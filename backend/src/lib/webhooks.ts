/**
 * webhooks.ts
 *
 * Real-time event notifications for external systems (issue #313).
 *
 * Dispatches signed HMAC-SHA256 HTTP POST payloads to active subscriber URLs
 * with exponential backoff and persistent retry worker / dead-letter queue (issue #379).
 */

import crypto from "node:crypto";
import { prisma } from "../db";

export interface WebhookPayload {
  event: string;
  timestamp: string;
  data: Record<string, unknown>;
}

/**
 * Computes an HMAC-SHA256 signature for a payload string using the given secret.
 */
export function computeWebhookSignature(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export interface DeliveryResult {
  attempt: number;
  success: boolean;
  statusCode?: number;
  error?: string;
}

export interface DeliveryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  backoffFactor?: number;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Delivers a signed payload to a subscriber URL, retrying with exponential
 * backoff if the endpoint is unreachable or returns a non-2xx status.
 */
export async function deliverWebhookWithRetry(
  url: string,
  payload: string,
  secret: string,
  event: string,
  options: DeliveryOptions = {},
): Promise<DeliveryResult> {
  const maxRetries = options.maxRetries ?? 3;
  const initialDelay = options.initialDelayMs ?? 1000;
  const backoffFactor = options.backoffFactor ?? 2;
  const fetcher = options.fetchFn ?? fetch;
  const sleeper = options.sleepFn ?? defaultSleep;

  const signature = computeWebhookSignature(payload, secret);

  let lastError: string | undefined;
  let lastStatus: number | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetcher(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signature-SHA256": signature,
          "X-Freelance-Event": event,
          "User-Agent": "Stellar-Freelance-Webhooks/1.0",
        },
        body: payload,
      });

      lastStatus = response.status;
      if (response.ok) {
        return { attempt, success: true, statusCode: response.status };
      }

      lastError = `HTTP ${response.status} ${response.statusText}`;
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    if (attempt < maxRetries) {
      const delay = initialDelay * Math.pow(backoffFactor, attempt - 1);
      await sleeper(delay);
    }
  }

  return {
    attempt: maxRetries,
    success: false,
    statusCode: lastStatus,
    error: lastError,
  };
}

export interface WebhookSubscriptionRecord {
  id: string;
  url: string;
  secret: string;
  events: string[];
  isActive: boolean;
}

export interface WebhookDeliveryRecord {
  id: string;
  subscriptionId?: string | null;
  url: string;
  secret: string;
  event: string;
  payload: string;
  status: "PENDING_RETRY" | "SUCCESS" | "DEAD_LETTER";
  attempts: number;
  maxAttempts: number;
  nextRetryAt: Date;
  responseCode?: number | null;
  lastError?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookStore {
  webhookSubscription?: {
    findMany: (args: { where: { isActive: boolean } }) => Promise<WebhookSubscriptionRecord[]>;
  };
  webhookDelivery?: {
    create: (args: { data: any }) => Promise<any>;
    findMany: (args: { where: any; take?: number; orderBy?: any }) => Promise<any[]>;
    update: (args: { where: { id: string }; data: any }) => Promise<any>;
  };
}

/**
 * Dispatches an event to all active subscriptions matching the event type.
 * Records failed deliveries into WebhookDelivery with status PENDING_RETRY (issue #379).
 */
export async function dispatchWebhooksForEvent(
  event: string,
  data: Record<string, unknown>,
  store: WebhookStore = prisma,
  deliveryOptions: DeliveryOptions = {},
): Promise<void> {
  if (!store?.webhookSubscription?.findMany) return;

  let subscriptions: WebhookSubscriptionRecord[] = [];
  try {
    subscriptions = await store.webhookSubscription.findMany({
      where: { isActive: true },
    });
  } catch (err) {
    console.error("[webhooks] failed to query active subscriptions:", err);
    return;
  }

  if (!subscriptions || subscriptions.length === 0) return;

  const matching = subscriptions.filter((sub) => {
    if (!sub.events || sub.events.length === 0 || sub.events.includes("*")) {
      return true;
    }
    const normalized = event.replace(/_/g, ".");
    return sub.events.includes(event) || sub.events.includes(normalized);
  });

  if (matching.length === 0) return;

  const payloadObject: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    data,
  };
  const payloadString = JSON.stringify(payloadObject);

  await Promise.allSettled(
    matching.map(async (sub) => {
      try {
        const result = await deliverWebhookWithRetry(
          sub.url,
          payloadString,
          sub.secret,
          event,
          deliveryOptions,
        );

        if (!result.success && store.webhookDelivery?.create) {
          const initialDelay = deliveryOptions.initialDelayMs ?? 1000;
          const backoffFactor = deliveryOptions.backoffFactor ?? 2;
          const nextDelay = initialDelay * Math.pow(backoffFactor, result.attempt);
          await store.webhookDelivery.create({
            data: {
              subscriptionId: sub.id,
              url: sub.url,
              secret: sub.secret,
              event,
              payload: payloadString,
              status: "PENDING_RETRY",
              attempts: result.attempt,
              maxAttempts: 5,
              nextRetryAt: new Date(Date.now() + nextDelay),
              responseCode: result.statusCode ?? null,
              lastError: result.error ?? null,
            },
          });
        }
      } catch (err) {
        console.error(`[webhooks] delivery exception to ${sub.url}:`, err);
        if (store.webhookDelivery?.create) {
          try {
            await store.webhookDelivery.create({
              data: {
                subscriptionId: sub.id,
                url: sub.url,
                secret: sub.secret,
                event,
                payload: payloadString,
                status: "PENDING_RETRY",
                attempts: 1,
                maxAttempts: 5,
                nextRetryAt: new Date(Date.now() + 1000),
                lastError: err instanceof Error ? err.message : String(err),
              },
            });
          } catch (createErr) {
            console.error(`[webhooks] failed to persist fallback delivery:`, createErr);
          }
        }
      }
    }),
  );
}

/**
 * Retries failed webhook deliveries with exponential backoff and dead-letter queue (issue #379).
 */
export async function processPendingWebhookDeliveries(
  store: WebhookStore = prisma,
  options: DeliveryOptions & { maxAttempts?: number } = {},
): Promise<{ processed: number; succeeded: number; retried: number; deadLettered: number }> {
  if (!store?.webhookDelivery?.findMany || !store?.webhookDelivery?.update) {
    return { processed: 0, succeeded: 0, retried: 0, deadLettered: 0 };
  }

  const now = new Date();
  const maxAttempts = options.maxAttempts ?? 5;
  const initialDelay = options.initialDelayMs ?? 1000;
  const backoffFactor = options.backoffFactor ?? 2;

  let pending: any[] = [];
  try {
    pending = await store.webhookDelivery.findMany({
      where: {
        status: "PENDING_RETRY",
        nextRetryAt: { lte: now },
      },
      take: 20,
      orderBy: { nextRetryAt: "asc" },
    });
  } catch (err) {
    console.error("[webhooks] error finding pending deliveries:", err);
    return { processed: 0, succeeded: 0, retried: 0, deadLettered: 0 };
  }

  let succeeded = 0;
  let retried = 0;
  let deadLettered = 0;

  for (const delivery of pending) {
    const result = await deliverWebhookWithRetry(
      delivery.url,
      delivery.payload,
      delivery.secret,
      delivery.event,
      {
        maxRetries: 1,
        fetchFn: options.fetchFn,
      },
    );

    const attempts = (delivery.attempts ?? 1) + 1;

    if (result.success) {
      await store.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "SUCCESS",
          attempts,
          responseCode: result.statusCode ?? 200,
          lastError: null,
        },
      });
      succeeded++;
    } else {
      if (attempts >= (delivery.maxAttempts ?? maxAttempts)) {
        await store.webhookDelivery.update({
          where: { id: delivery.id },
          data: {
            status: "DEAD_LETTER",
            attempts,
            responseCode: result.statusCode ?? null,
            lastError: result.error ?? "Max retry attempts exceeded",
          },
        });
        deadLettered++;
      } else {
        const nextDelay = initialDelay * Math.pow(backoffFactor, attempts);
        await store.webhookDelivery.update({
          where: { id: delivery.id },
          data: {
            status: "PENDING_RETRY",
            attempts,
            nextRetryAt: new Date(Date.now() + nextDelay),
            responseCode: result.statusCode ?? null,
            lastError: result.error ?? null,
          },
        });
        retried++;
      }
    }
  }

  return {
    processed: pending.length,
    succeeded,
    retried,
    deadLettered,
  };
}

export interface WebhookWorkerHandle {
  stop: () => void;
  processOnce: () => Promise<{ processed: number; succeeded: number; retried: number; deadLettered: number }>;
}

/**
 * Runs a background worker retrying pending webhook deliveries periodically (issue #379).
 */
export function startWebhookRetryWorker(
  options: {
    store?: WebhookStore;
    intervalMs?: number;
    fetchFn?: typeof fetch;
    maxAttempts?: number;
    initialDelayMs?: number;
    backoffFactor?: number;
  } = {},
): WebhookWorkerHandle {
  const store = options.store ?? prisma;
  const intervalMs = options.intervalMs ?? 5000;
  let running = false;
  let timer: NodeJS.Timeout | null = null;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      await processPendingWebhookDeliveries(store, options);
    } catch (err) {
      console.error("[webhooks-worker] unhandled cycle error:", err);
    } finally {
      running = false;
    }
  };

  timer = setInterval(() => {
    void run();
  }, intervalMs);
  if (timer.unref) timer.unref();

  return {
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    processOnce: () => processPendingWebhookDeliveries(store, options),
  };
}
