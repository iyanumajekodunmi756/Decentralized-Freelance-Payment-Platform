import { PrismaClient } from "@prisma/client";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { DatabaseTimeoutError } from "./middleware/errorHandler";
import { tracer } from "./lib/tracing";

export { DatabaseTimeoutError };

export const SLOW_QUERY_THRESHOLD_MS = 1_000;
export const QUERY_TIMEOUT_MS = 10_000;

export interface PoolMonitoringStats {
  activeQueries: number;
  totalQueries: number;
  slowQueries: number;
  timedOutQueries: number;
}

export const poolStats: PoolMonitoringStats = {
  activeQueries: 0,
  totalQueries: 0,
  slowQueries: 0,
  timedOutQueries: 0,
};

export function getPoolStats(): PoolMonitoringStats {
  return { ...poolStats };
}

export const DEFAULT_REPLICA_LAG_THRESHOLD_MS = 30_000;
export const REPLICA_HEALTH_TIMEOUT_MS = 3_000;

/** Minimal surface of a Prisma client used to probe a read replica. */
export interface ReplicaQueryClient {
  $queryRawUnsafe<T = unknown>(query: string): Promise<T>;
}

export interface ReplicationHealth {
  /** Whether REPLICA_URL is configured at all. */
  configured: boolean;
  /** Whether the replica answered the probe query. */
  connected: boolean;
  /** Whether the replica reports itself as a standby (pg_is_in_recovery()). */
  inRecovery: boolean | null;
  /** Replication lag in milliseconds, or null when it cannot be determined. */
  lagMs: number | null;
  lagSeconds: number | null;
  thresholdMs: number;
  thresholdSeconds: number;
  /** True when connected but lag exceeds the configured threshold. */
  degraded: boolean;
  error?: string;
}

export interface ReplicationHealthOptions {
  replicaUrl?: string;
  thresholdMs?: number;
  /** Injection point for tests; defaults to a lazily created Prisma client. */
  client?: ReplicaQueryClient;
  timeoutMs?: number;
}

/**
 * Time-based lag probe for a PostgreSQL streaming replica (issue #381).
 *
 * `pg_last_xact_replay_timestamp()` is the commit timestamp of the last
 * transaction replayed on the standby, so `NOW() - replay_timestamp` is how far
 * behind the primary the replica is. Both values are read from the replica, so
 * the result does not depend on clock skew between hosts. Byte lag would need
 * the primary's LSN, which a standby cannot read on its own.
 */
export const REPLICA_LAG_QUERY = `
  SELECT
    pg_is_in_recovery() AS in_recovery,
    pg_last_xact_replay_timestamp() AS replay_timestamp,
    NOW() AS now
`;

interface ReplicaLagRow {
  in_recovery: boolean;
  replay_timestamp: Date | string | null;
  now: Date | string;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

const globalForReplica = globalThis as unknown as { replicaPrisma?: PrismaClient };

function getReplicaClient(replicaUrl: string): PrismaClient {
  const url = formatDatabaseUrl(replicaUrl) ?? replicaUrl;
  if (!globalForReplica.replicaPrisma) {
    globalForReplica.replicaPrisma = new PrismaClient({
      datasources: { db: { url } },
      log: ["error"],
    });
  }
  return globalForReplica.replicaPrisma;
}

/** Disconnect the lazily created replica client (used on shutdown and in tests). */
export async function closeReplicaClient(): Promise<void> {
  const client = globalForReplica.replicaPrisma;
  if (!client) return;
  globalForReplica.replicaPrisma = undefined;
  await client.$disconnect();
}

/**
 * Probe the configured read replica and report its replication lag.
 * Never throws: a failed probe is reported as `connected: false` so /health can
 * degrade instead of erroring.
 */
export async function checkReplicationHealth(
  options: ReplicationHealthOptions = {},
): Promise<ReplicationHealth> {
  const replicaUrl = options.replicaUrl ?? process.env.REPLICA_URL;
  const thresholdMs =
    options.thresholdMs ??
    (process.env.REPLICA_LAG_THRESHOLD_MS
      ? parseInt(process.env.REPLICA_LAG_THRESHOLD_MS, 10)
      : DEFAULT_REPLICA_LAG_THRESHOLD_MS);

  const base = {
    configured: Boolean(replicaUrl),
    thresholdMs,
    thresholdSeconds: thresholdMs / 1000,
  };

  if (!replicaUrl) {
    return {
      ...base,
      connected: false,
      inRecovery: null,
      lagMs: null,
      lagSeconds: null,
      degraded: false,
    };
  }

  try {
    const client = options.client ?? getReplicaClient(replicaUrl);
    const rows = await withTimeout(
      client.$queryRawUnsafe<ReplicaLagRow[]>(REPLICA_LAG_QUERY),
      options.timeoutMs ?? REPLICA_HEALTH_TIMEOUT_MS,
      "Read replica health check timed out",
    );

    const row = rows[0];
    if (!row) throw new Error("Read replica health check returned no rows");

    const inRecovery = Boolean(row.in_recovery);
    // A primary (or a replica that has not replayed anything yet) has no replay
    // timestamp. Treat a primary as zero lag and an unstarted standby as unknown
    // rather than reporting a large false-positive lag.
    const lagMs = inRecovery
      ? row.replay_timestamp
        ? Math.max(0, new Date(row.now).getTime() - new Date(row.replay_timestamp).getTime())
        : null
      : 0;

    return {
      ...base,
      connected: true,
      inRecovery,
      lagMs,
      lagSeconds: lagMs === null ? null : lagMs / 1000,
      degraded: lagMs !== null && lagMs > thresholdMs,
    };
  } catch (error) {
    return {
      ...base,
      connected: false,
      inRecovery: null,
      lagMs: null,
      lagSeconds: null,
      degraded: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function resetPoolStats(): void {
  poolStats.activeQueries = 0;
  poolStats.totalQueries = 0;
  poolStats.slowQueries = 0;
  poolStats.timedOutQueries = 0;
}

export interface DatabaseUrlOptions {
  statementTimeoutMs?: number;
  connectionLimit?: number;
  poolTimeoutSeconds?: number;
}

/**
 * Configure PostgreSQL `statement_timeout` (in milliseconds), `connection_limit`,
 * and `pool_timeout` parameters on the database connection string (issue #275).
 */
export function formatDatabaseUrl(
  rawUrl?: string,
  options?: DatabaseUrlOptions | number,
): string | undefined {
  if (!rawUrl) return rawUrl;

  const resolvedOptions: DatabaseUrlOptions =
    typeof options === "number" ? { statementTimeoutMs: options } : (options ?? {});

  const statementTimeout =
    resolvedOptions.statementTimeoutMs ??
    (process.env.DATABASE_TIMEOUT_MS ? parseInt(process.env.DATABASE_TIMEOUT_MS, 10) : QUERY_TIMEOUT_MS);

  const connectionLimit =
    resolvedOptions.connectionLimit ??
    (process.env.DATABASE_POOL_SIZE ? parseInt(process.env.DATABASE_POOL_SIZE, 10) : 10);

  const poolTimeout =
    resolvedOptions.poolTimeoutSeconds ??
    Math.max(1, Math.round(statementTimeout / 1000));

  try {
    const url = new URL(rawUrl);
    if (!url.searchParams.has("statement_timeout")) {
      url.searchParams.set("statement_timeout", String(statementTimeout));
    }
    if (!url.searchParams.has("connection_limit")) {
      url.searchParams.set("connection_limit", String(connectionLimit));
    }
    if (!url.searchParams.has("pool_timeout")) {
      url.searchParams.set("pool_timeout", String(poolTimeout));
    }
    return url.toString();
  } catch {
    let result = rawUrl;
    if (!result.includes("statement_timeout=")) {
      const sep = result.includes("?") ? "&" : "?";
      result = `${result}${sep}statement_timeout=${statementTimeout}`;
    }
    if (!result.includes("connection_limit=")) {
      const sep = result.includes("?") ? "&" : "?";
      result = `${result}${sep}connection_limit=${connectionLimit}`;
    }
    if (!result.includes("pool_timeout=")) {
      const sep = result.includes("?") ? "&" : "?";
      result = `${result}${sep}pool_timeout=${poolTimeout}`;
    }
    return result;
  }
}

export { withTransactionRetry } from "./lib/transactionRetry";

/**
 * Attach query execution timing, slow-query logging (> 1,000ms), and timeout abort (10s)
 * middleware to a PrismaClient instance.
 */
export function setupPrismaQueryMonitoring(
  client: PrismaClient,
  queryTimeoutMs: number = QUERY_TIMEOUT_MS,
): void {
  client.$use(async (params, next) => {
    poolStats.activeQueries++;
    poolStats.totalQueries++;
    const start = Date.now();

    const span = tracer.startSpan(`prisma.${params.model ?? "raw"}.${params.action}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        "db.system": "postgresql",
        "db.operation": params.action,
        ...(params.model ? { "db.model": params.model } : {}),
      },
    });

    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        poolStats.timedOutQueries++;
        reject(
          new DatabaseTimeoutError(
            `Query execution timed out after ${queryTimeoutMs}ms (${params.model ? `${params.model}.` : ""}${params.action})`,
          ),
        );
      }, queryTimeoutMs);
    });

    try {
      const result = await Promise.race([next(params), timeoutPromise]);
      const duration = Date.now() - start;
      span.setAttribute("db.duration_ms", duration);
      span.setStatus({ code: SpanStatusCode.OK });
      if (duration > SLOW_QUERY_THRESHOLD_MS) {
        poolStats.slowQueries++;
        span.setAttribute("db.slow_query", true);
        console.warn(
          `[slow_query] ${params.model ? `${params.model}.` : ""}${params.action} took ${duration}ms`,
        );
      }
      return result;
    } catch (error) {
      const duration = Date.now() - start;
      span.setAttribute("db.duration_ms", duration);
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      if (duration > SLOW_QUERY_THRESHOLD_MS) {
        span.setAttribute("db.slow_query", true);
        console.warn(
          `[slow_query] ${params.model ? `${params.model}.` : ""}${params.action} failed after ${duration}ms`,
        );
      }
      throw error;
    } finally {
      span.end();
      if (timer) clearTimeout(timer);
      poolStats.activeQueries--;
    }
  });
}

export function createPrismaClient(databaseUrl?: string): PrismaClient {
  const url = formatDatabaseUrl(databaseUrl ?? process.env.DATABASE_URL);
  if (url) {
    process.env.DATABASE_URL = url;
  }
  const client = new PrismaClient({ log: ["error"] });
  setupPrismaQueryMonitoring(client);
  return client;
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
