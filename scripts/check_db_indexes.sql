-- scripts/check_db_indexes.sql
-- Automated database index bloat check and health monitor query (issue #378).
--
-- Measures:
-- 1. Table cache hit ratio (heap read vs hit)
-- 2. Index cache hit ratio (idx read vs hit)
-- 3. Unused indexes (0 scans on non-unique user indexes)
-- 4. Index size, scan counts, and bloat metrics across tables

-- 1. Buffer Cache Hit Ratios
SELECT
  'cache_hit_ratio' AS metric_type,
  'table' AS target,
  ROUND(
    100.0 * SUM(heap_blks_hit) / NULLIF(SUM(heap_blks_hit + heap_blks_read), 0),
    2
  ) AS hit_percentage
FROM pg_statio_user_tables
UNION ALL
SELECT
  'cache_hit_ratio' AS metric_type,
  'index' AS target,
  ROUND(
    100.0 * SUM(idx_blks_hit) / NULLIF(SUM(idx_blks_hit + idx_blks_read), 0),
    2
  ) AS hit_percentage
FROM pg_statio_user_tables;

-- 2. Unused Indexes (Zero scans since stats reset, excluding unique/primary keys)
SELECT
  schemaname,
  relname AS table_name,
  indexrelname AS index_name,
  idx_scan AS scan_count,
  pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes ui
JOIN pg_index i ON ui.indexrelid = i.indexrelid
WHERE ui.idx_scan = 0
  AND NOT i.indisunique
  AND NOT i.indisprimary
ORDER BY pg_relation_size(indexrelid) DESC;

-- 3. Table & Index Sizes and Scans
SELECT
  ui.schemaname,
  ui.relname AS table_name,
  ui.indexrelname AS index_name,
  ui.idx_scan,
  ui.idx_tup_read,
  ui.idx_tup_fetch,
  pg_size_pretty(pg_relation_size(ui.indexrelid)) AS index_size_pretty,
  pg_relation_size(ui.indexrelid) AS index_bytes,
  pg_size_pretty(pg_relation_size(ui.relid)) AS table_size_pretty,
  pg_relation_size(ui.relid) AS table_bytes
FROM pg_stat_user_indexes ui
JOIN pg_statio_user_indexes uio ON ui.indexrelid = uio.indexrelid
ORDER BY pg_relation_size(ui.indexrelid) DESC;
