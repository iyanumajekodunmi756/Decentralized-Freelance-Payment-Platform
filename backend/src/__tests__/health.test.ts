import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import {
  checkReplicationHealth,
  REPLICA_LAG_QUERY,
  type ReplicaQueryClient,
  type ReplicationHealth,
} from "../db";

// Read replica lag health probe (issue #381).

afterEach(() => {
  vi.restoreAllMocks();
});

function replicaClient(rows: unknown[]): ReplicaQueryClient {
  return {
    $queryRawUnsafe: vi.fn().mockResolvedValue(rows),
  } as unknown as ReplicaQueryClient;
}

async function startApp(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const { createApp } = await import("../app");
  const app = await createApp();
  const server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port assigned");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function mockHealthyPrimary() {
  const { prisma } = await import("../db");
  const soroban = await import("../lib/soroban");
  vi.spyOn(soroban, "checkSorobanRpcHealth").mockResolvedValue(true);
  vi.spyOn(prisma, "$queryRaw").mockResolvedValue([{ "?column?": 1 }]);
  vi.spyOn(prisma.indexerCursor, "findUnique").mockResolvedValue({
    id: "main",
    lastLedger: 100,
    updatedAt: new Date(),
  } as unknown as Awaited<ReturnType<typeof prisma.indexerCursor.findUnique>>);
}

describe("checkReplicationHealth", () => {
  it("does not probe anything when no replica URL is configured", async () => {
    const client = replicaClient([{ in_recovery: true, replay_timestamp: new Date(), now: new Date() }]);

    const result = await checkReplicationHealth({ replicaUrl: undefined, client });
    // The injected client must not be touched without a URL.
    expect(client.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(result).toEqual({
      configured: false,
      connected: false,
      inRecovery: null,
      lagMs: null,
      lagSeconds: null,
      thresholdMs: 30_000,
      thresholdSeconds: 30,
      degraded: false,
    });
  });

  it("reports the time-based lag from pg_last_xact_replay_timestamp()", async () => {
    const now = new Date("2026-11-22T12:00:10.000Z");
    const client = replicaClient([
      { in_recovery: true, replay_timestamp: new Date("2026-11-22T12:00:08.000Z"), now },
    ]);

    const result = await checkReplicationHealth({ replicaUrl: "postgresql://replica/db", client });

    expect(client.$queryRawUnsafe).toHaveBeenCalledWith(REPLICA_LAG_QUERY);
    expect(REPLICA_LAG_QUERY).toContain("pg_last_xact_replay_timestamp()");
    expect(result.configured).toBe(true);
    expect(result.connected).toBe(true);
    expect(result.inRecovery).toBe(true);
    expect(result.lagMs).toBe(2_000);
    expect(result.lagSeconds).toBe(2);
    expect(result.degraded).toBe(false);
  });

  it("marks the replica degraded when lag exceeds the threshold", async () => {
    const now = new Date("2026-11-22T12:01:00.000Z");
    const client = replicaClient([
      { in_recovery: true, replay_timestamp: new Date("2026-11-22T12:00:00.000Z"), now },
    ]);

    const result = await checkReplicationHealth({
      replicaUrl: "postgresql://replica/db",
      thresholdMs: 30_000,
      client,
    });

    expect(result.lagSeconds).toBe(60);
    expect(result.degraded).toBe(true);
  });

  it("honours a custom threshold", async () => {
    const now = new Date("2026-11-22T12:00:10.000Z");
    const client = replicaClient([
      { in_recovery: true, replay_timestamp: new Date("2026-11-22T12:00:05.000Z"), now },
    ]);

    const result = await checkReplicationHealth({
      replicaUrl: "postgresql://replica/db",
      thresholdMs: 10_000,
      client,
    });

    expect(result.lagMs).toBe(5_000);
    expect(result.degraded).toBe(false);
  });

  it("treats a primary (not in recovery) as zero lag", async () => {
    const client = replicaClient([
      { in_recovery: false, replay_timestamp: null, now: new Date() },
    ]);

    const result = await checkReplicationHealth({ replicaUrl: "postgresql://replica/db", client });

    expect(result.connected).toBe(true);
    expect(result.inRecovery).toBe(false);
    expect(result.lagMs).toBe(0);
    expect(result.degraded).toBe(false);
  });

  it("reports unknown lag rather than a false positive when nothing has replayed yet", async () => {
    const client = replicaClient([
      { in_recovery: true, replay_timestamp: null, now: new Date() },
    ]);

    const result = await checkReplicationHealth({ replicaUrl: "postgresql://replica/db", client });

    expect(result.connected).toBe(true);
    expect(result.lagMs).toBeNull();
    expect(result.lagSeconds).toBeNull();
    expect(result.degraded).toBe(false);
  });

  it("marks the replica degraded and returns the error when the probe fails", async () => {
    const client = {
      $queryRawUnsafe: vi.fn().mockRejectedValue(new Error("connection refused")),
    } as unknown as ReplicaQueryClient;

    const result = await checkReplicationHealth({ replicaUrl: "postgresql://replica/db", client });

    expect(result.connected).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.error).toContain("connection refused");
  });

  it("fails closed when the probe returns no rows", async () => {
    const result = await checkReplicationHealth({
      replicaUrl: "postgresql://replica/db",
      client: replicaClient([]),
    });

    expect(result.connected).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.error).toContain("no rows");
  });
});

describe("GET /health with a read replica", () => {
  function replication(overrides: Partial<ReplicationHealth> = {}): ReplicationHealth {
    return {
      configured: true,
      connected: true,
      inRecovery: true,
      lagMs: 2_000,
      lagSeconds: 2,
      thresholdMs: 30_000,
      thresholdSeconds: 30,
      degraded: false,
      ...overrides,
    };
  }

  it("omits replication status when REPLICA_URL is not configured", async () => {
    await mockHealthyPrimary();
    const db = await import("../db");
    vi.spyOn(db, "checkReplicationHealth").mockResolvedValue(replication({ configured: false }));

    const { baseUrl, close } = await startApp();
    try {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("ok");
      expect(body).not.toHaveProperty("replication");
    } finally {
      await close();
    }
  });

  it("returns 200 with lag metrics when the replica is healthy", async () => {
    await mockHealthyPrimary();
    const db = await import("../db");
    vi.spyOn(db, "checkReplicationHealth").mockResolvedValue(replication());

    const { baseUrl, close } = await startApp();
    try {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; replication: ReplicationHealth };
      expect(body.status).toBe("ok");
      expect(body.replication.configured).toBe(true);
      expect(body.replication.connected).toBe(true);
      expect(body.replication.lagSeconds).toBe(2);
      expect(body.replication.degraded).toBe(false);
    } finally {
      await close();
    }
  });

  it("returns 503 degraded when replica lag exceeds the threshold", async () => {
    await mockHealthyPrimary();
    const db = await import("../db");
    vi.spyOn(db, "checkReplicationHealth").mockResolvedValue(
      replication({ lagMs: 60_000, lagSeconds: 60, degraded: true }),
    );

    const { baseUrl, close } = await startApp();
    try {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as {
        status: string;
        replication: ReplicationHealth;
        message: string;
      };
      expect(body.status).toBe("degraded");
      expect(body.replication.degraded).toBe(true);
      expect(body.message).toContain("exceeds");
    } finally {
      await close();
    }
  });

  it("returns 503 degraded when the replica is unreachable", async () => {
    await mockHealthyPrimary();
    const db = await import("../db");
    vi.spyOn(db, "checkReplicationHealth").mockResolvedValue(
      replication({
        connected: false,
        inRecovery: null,
        lagMs: null,
        lagSeconds: null,
        degraded: true,
        error: "connection refused",
      }),
    );

    const { baseUrl, close } = await startApp();
    try {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { status: string; message: string };
      expect(body.status).toBe("degraded");
      expect(body.message).toContain("unreachable");
      expect(body.message).toContain("connection refused");
    } finally {
      await close();
    }
  });

  it("includes replication metrics on the indexer-staleness degraded response", async () => {
    const { prisma } = await import("../db");
    const soroban = await import("../lib/soroban");
    vi.spyOn(soroban, "checkSorobanRpcHealth").mockResolvedValue(true);
    vi.spyOn(prisma, "$queryRaw").mockResolvedValue([{ "?column?": 1 }]);
    vi.spyOn(prisma.indexerCursor, "findUnique").mockResolvedValue({
      id: "main",
      lastLedger: 100,
      // Advanced, but not recently: stale rather than down.
      updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    } as unknown as Awaited<ReturnType<typeof prisma.indexerCursor.findUnique>>);
    const db = await import("../db");
    vi.spyOn(db, "checkReplicationHealth").mockResolvedValue(replication());

    const { baseUrl, close } = await startApp();
    try {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; replication: ReplicationHealth };
      expect(body.status).toBe("degraded");
      expect(body.replication.lagSeconds).toBe(2);
    } finally {
      await close();
    }
  });
});
