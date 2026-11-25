/**
 * FreelancerDirectory.tsx
 *
 * Public directory of freelancers with on-chain reputation and stats (#68).
 * Supports search by name, bio, or Stellar address, and sorting by reputation,
 * completed jobs, or join date. Each freelancer entry links to the Profile page.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import Layout from "../components/Layout";
import AddressField from "../components/AddressField";
import { fetchFreelancers, type FreelancerApi } from "../lib/api";
import { useDebounce } from "../hooks/useDebounce";

const PAGE_SIZE = 10;

type SortOrder = "asc" | "desc";
const sortFields = { rep: "reputation", jobs: "jobs", recent: "recent" } as const;
type SortKey = keyof typeof sortFields;
type SortOption = `${SortKey}_${SortOrder}`;

export default function FreelancerDirectory() {
  const [freelancers, setFreelancers] = useState<FreelancerApi[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState("");
  const debouncedSearch = useDebounce(searchInput, 300);
  const [activeSearch, setActiveSearch] = useState("");
  const [sortOption, setSortOption] = useState<SortOption>(
    "rep_desc",
  );
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);

  const loadFreelancers = useCallback(
    async (pageToLoad: number, append: boolean, signal?: AbortSignal) => {
      setLoading(true);
      setError(null);

      const [key, sortOrder] = sortOption.split("_") as [SortKey, SortOrder];
      const sortBy = sortFields[key];

      try {
        const data = await fetchFreelancers(
          {
            search: activeSearch || undefined,
            sortBy,
            sortOrder,
            page: pageToLoad,
            limit: PAGE_SIZE,
          },
          signal,
        );

        if (signal?.aborted) return;
        setFreelancers((prev) => (append ? [...prev, ...data.freelancers] : data.freelancers));
        setTotal(data.total);
        setHasMore(data.freelancers.length === PAGE_SIZE && pageToLoad < data.totalPages);
        setPage(pageToLoad);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [activeSearch, sortOption],
  );

  // Search runs against the settled input, not every keystroke.
  useEffect(() => {
    setActiveSearch(debouncedSearch.trim());
  }, [debouncedSearch]);

  const inFlight = useRef<AbortController | null>(null);

  // Cancel a request from the previous query as soon as the user types again.
  useEffect(() => {
    inFlight.current?.abort();
  }, [searchInput]);

  useEffect(() => {
    const controller = new AbortController();
    inFlight.current = controller;
    void loadFreelancers(1, false, controller.signal);
    return () => controller.abort();
  }, [loadFreelancers]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setActiveSearch(searchInput.trim());
  };

  const handleClearSearch = () => {
    setSearchInput("");
    setActiveSearch("");
  };

  return (
    <Layout>
      <header style={{ marginBottom: "1.5rem" }}>
        <h1>Freelancer Directory</h1>
        <p className="muted">
          Browse verified freelancers with on-chain reputation scores and completed escrow jobs.
        </p>
      </header>

      {/* Search and Sort Controls */}
      <div
        className="card"
        style={{
          marginBottom: "1.5rem",
          display: "flex",
          flexWrap: "wrap",
          gap: "1rem",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <form
          onSubmit={handleSearchSubmit}
          style={{ display: "flex", gap: "0.5rem", flex: "1 1 300px", alignItems: "center" }}
        >
          <input
            type="search"
            aria-label="Search freelancers"
            placeholder="Search name, bio, or address…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            style={{ flex: 1 }}
          />
          <button type="submit">Search</button>
          {activeSearch && (
            <button type="button" onClick={handleClearSearch} title="Clear search">
              Clear
            </button>
          )}
        </form>

        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <label htmlFor="sort-select" style={{ fontSize: "0.9rem", color: "var(--muted)" }}>
            Sort by:
          </label>
          <select
            id="sort-select"
            aria-label="Sort freelancers by"
            value={sortOption}
            onChange={(e) =>
              setSortOption(
                e.target.value as SortOption,
              )
            }
          >
            <option value="rep_desc">Reputation: Highest first</option>
            <option value="rep_asc">Reputation: Lowest first</option>
            <option value="jobs_desc">Most Completed Jobs</option>
            <option value="jobs_asc">Fewest Completed Jobs</option>
            <option value="recent_desc">Recently Joined</option>
            <option value="recent_asc">Earliest Joined</option>
          </select>
        </div>
      </div>

      {error && (
        <p role="alert" className="alert alert-error">
          {error}
        </p>
      )}

      {loading && freelancers.length === 0 && <p>Loading freelancers…</p>}

      {!loading && !error && freelancers.length === 0 && (
        <div className="card" style={{ textAlign: "center", padding: "2rem" }}>
          <p className="muted" style={{ margin: 0 }}>
            {activeSearch
              ? `No freelancers found matching "${activeSearch}".`
              : "No freelancers currently registered."}
          </p>
        </div>
      )}

      {freelancers.length > 0 && (
        <div>
          <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.75rem" }}>
            Showing {freelancers.length} of {total} {total === 1 ? "freelancer" : "freelancers"}
          </p>

          <table className="freelancer-directory-table" aria-label="Freelancers">
            <thead>
              <tr>
                <th scope="col">Freelancer</th>
                {([["rep", "Reputation"], ["jobs", "Completed projects"], ["recent", "Joined"]] as const).map(([key, label]) => {
                  const selected = sortOption.startsWith(`${key}_`);
                  const ascending = sortOption.endsWith("_asc");
                  return (
                    <th key={key} scope="col" aria-sort={selected ? ascending ? "ascending" : "descending" : undefined}>
                      <button type="button" onClick={() => setSortOption(`${key}_${selected && !ascending ? "asc" : "desc"}`)}>
                        {label}{selected && <span aria-hidden="true">{ascending ? " ↑" : " ↓"}</span>}
                      </button>
                    </th>
                  );
                })}
                <th scope="col">Profile</th>
              </tr>
            </thead>
            <tbody>
              {freelancers.map((freelancer) => (
                <tr key={freelancer.id}>
                  <td>
                    <strong>{freelancer.displayName || "Anonymous Freelancer"}</strong>
                    <AddressField address={freelancer.stellarAddress} truncate qr />
                    {freelancer.bio && <p>{freelancer.bio}</p>}
                  </td>
                  <td>
                    {freelancer.totalRatings > 0 ? (
                      <>
                        <strong>★ {freelancer.averageScore.toFixed(2)} / 5</strong>
                        <div className="muted">{freelancer.totalRatings} {freelancer.totalRatings === 1 ? "rating" : "ratings"}</div>
                      </>
                    ) : "No ratings yet"}
                  </td>
                  <td>{freelancer.completedJobsCount} {freelancer.completedJobsCount === 1 ? "job completed" : "jobs completed"}</td>
                  <td><time dateTime={freelancer.createdAt}>{new Date(freelancer.createdAt).toLocaleDateString()}</time></td>
                  <td><Link to={`/profile/${freelancer.stellarAddress}`}>View Profile →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasMore && (
        <div style={{ textAlign: "center", marginTop: "1.5rem" }}>
          <button disabled={loading} onClick={() => void loadFreelancers(page + 1, true)}>
            {loading ? "Loading…" : "Load more freelancers"}
          </button>
        </div>
      )}
    </Layout>
  );
}
