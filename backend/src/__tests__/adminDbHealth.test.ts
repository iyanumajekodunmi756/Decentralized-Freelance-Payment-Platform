// Copyright (c) 2026 Stellar Freelance Payment Platform Contributors
// SPDX-License-Identifier: MIT

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { SignJWT } from "jose";

const h = vi.hoisted(() => ({
  secret: "test-admin-db-health-secret-at-least-32-chars",
  admin: "GADMIN_DB_HEALTH",
  userFindUnique: vi.fn(),
  queryRawUnsafe: vi.fn(),
}));

vi.mock("../config", () => ({
  config: {
    JWT_SECRET: h.secret,
    INDEXER_ADMIN_ADDRESSES: h.admin,
  },
}));

vi.mock("../db", () => ({
  prisma: {
    user: { findUnique: h.userFindUnique },
    $queryRawUnsafe: h.queryRawUnsafe,
  },
}));

let baseUrl: string;
let server: Server;

beforeAll(async () => {
  const { adminIndexerRouter } = await import("../routes/adminIndexer");
  const { errorHandler } = await import("../middleware/errorHandler");
  const app = express();
  app.use("/api/admin", adminIndexerRouter);
  app.use("/api/admin/indexer", adminIndexerRouter);
  app.use(errorHandler);

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port assigned");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});

async function tokenFor(stellarAddress: string): Promise<string> {
  const key = new TextEncoder().encode(h.secret);
  return await new SignJWT({ sub: stellarAddress })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
}

describe("GET /api/admin/db-health & GET /api/admin/indexer/db-health (issue #378)", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const res = await fetch(`${baseUrl}/api/admin/db-health`);
    expect(res.status).toBe(401);
  });

  it("rejects non-admin authenticated caller with 403", async () => {
    const token = await tokenFor("GREGULAR_USER");
    h.userFindUnique.mockResolvedValueOnce({
      id: "u1",
      stellarAddress: "GREGULAR_USER",
      sessions: [],
    });

    const res = await fetch(`${baseUrl}/api/admin/db-health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it("returns database health metrics for authenticated admin", async () => {
    const token = await tokenFor(h.admin);
    h.userFindUnique.mockResolvedValueOnce({
      id: "admin1",
      stellarAddress: h.admin,
      sessions: [],
    });

    h.queryRawUnsafe
      .mockResolvedValueOnce([
        { target: "table", hit_percentage: "99.85" },
        { target: "index", hit_percentage: "99.95" },
      ])
      .mockResolvedValueOnce([
        {
          table_name: "Notification",
          index_name: "Notification_userId_idx",
          scan_count: 0n,
          index_size: "16 kB",
        },
      ])
      .mockResolvedValueOnce([
        {
          table_name: "Job",
          index_name: "Job_pkey",
          scan_count: 1540n,
          index_size: "32 kB",
          table_size: "64 kB",
        },
      ]);

    const res = await fetch(`${baseUrl}/api/admin/db-health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.status).toBe("healthy");
    expect(body.cacheHitRatio.table).toBe(99.85);
    expect(body.cacheHitRatio.index).toBe(99.95);
    expect(body.unusedIndexes).toHaveLength(1);
    expect(body.unusedIndexes[0].tableName).toBe("Notification");
    expect(body.indexes).toHaveLength(1);
    expect(body.indexes[0].tableName).toBe("Job");
  });

  it("gracefully returns degraded status if catalog query throws", async () => {
    const token = await tokenFor(h.admin);
    h.userFindUnique.mockResolvedValueOnce({
      id: "admin1",
      stellarAddress: h.admin,
      sessions: [],
    });

    h.queryRawUnsafe.mockRejectedValueOnce(new Error("Catalog query failed"));

    const res = await fetch(`${baseUrl}/api/admin/indexer/db-health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.status).toBe("degraded");
    expect(body.warning).toContain("Catalog query failed");
  });
});
