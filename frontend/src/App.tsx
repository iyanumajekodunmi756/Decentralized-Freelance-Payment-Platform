/**
 * App.tsx
 *
 * Root component. Defines top-level routes and the wallet-aware navigation.
 *
 * Routes:
 *   /              → Dashboard (connect wallet, open a job by id)
 *   /freelancers   → FreelancerDirectory (talent discovery, #68, #251)
 *   /post          → PostJob (client creates + funds a new escrow)
 *   /activity      → Activity (earnings + open escrows for the wallet, #73)
 *   /jobs/:id      → JobDetail (milestone tracker, release + dispute)
 *   /jobs/:id/receipt → Receipt (printable/exportable record)
 *   /profile/:addr → Profile (reputation score)
 *   *              → NotFound (catch-all for unknown paths, #29)
 */

import { lazy, Suspense } from "react";
import { BrowserRouter, Link, NavLink, Route, Routes } from "react-router-dom";
import { WalletProvider } from "./hooks/WalletProvider";
import { ToastProvider } from "./hooks/ToastProvider";
import { useWallet } from "./hooks/wallet-context";
import { ACTIVE_NETWORK } from "./lib/stellar";
import AddressField from "./components/AddressField";
import NotificationsBell from "./components/NotificationsBell";
import Logo from "./components/Logo";
import JobDetailSkeleton from "./components/JobDetailSkeleton";
import Toaster from "./components/Toaster";
import SessionExpiredModal from "./components/SessionExpiredModal";

// Dynamic route code splitting (issue #293)
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Activity = lazy(() => import("./pages/Activity"));
const PostJob = lazy(() => import("./pages/PostJob"));
const JobDetail = lazy(() => import("./pages/JobDetail"));
const Receipt = lazy(() => import("./pages/Receipt"));
const Profile = lazy(() => import("./pages/Profile"));
const FreelancerDirectory = lazy(() => import("./pages/FreelancerDirectory"));
const NotFound = lazy(() => import("./pages/NotFound"));

export function Nav() {
  const { publicKey, connecting, connect, disconnect } = useWallet();
  return (
    <nav className="nav" aria-label="Main navigation">
      <Link to="/" className="nav-brand" aria-label="Stellar Freelance Platform Home">
        <Logo size={28} />
      </Link>
      <NavLink to="/" end>My Jobs</NavLink>
      <NavLink to="/activity">Activity</NavLink>
      <NavLink to="/freelancers">Freelancers</NavLink>
      <NavLink to="/post">Post a Job</NavLink>
      <span className="nav-spacer" style={{ display: "inline-flex", alignItems: "center" }}>
        {publicKey ? (
          <>
            <NotificationsBell />
            <AddressField address={publicKey} truncate />{" "}
            <button onClick={disconnect}>Disconnect</button>
          </>
        ) : (
          <button onClick={() => void connect()} disabled={connecting}>
            {connecting ? "Connecting…" : "Connect Wallet"}
          </button>
        )}
      </span>
    </nav>
  );
}

function NetworkMismatchBanner() {
  const { publicKey, networkMismatch } = useWallet();

  if (!publicKey || !networkMismatch) return null;

  const networkName = ACTIVE_NETWORK === "testnet" ? "Testnet" : "Mainnet";

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="alert alert-error"
      style={{
        margin: 0,
        borderRadius: 0,
        padding: "0.8rem 1rem",
        textAlign: "center",
      }}
    >
      Your wallet is connected to a different network. Please switch to {networkName} in your wallet.
    </div>
  );
}

export default function App() {
  return (
    <WalletProvider>
      <ToastProvider>
        <BrowserRouter>
          <a href="#main-content" className="skip-link">
            Skip to main content
          </a>
          <Nav />
          <NetworkMismatchBanner />
          {/* Global session-expiry prompt (issue #364). Rendered as an overlay so
              the active route and any unsubmitted form state stay mounted. */}
          <SessionExpiredModal />
          <Suspense fallback={<JobDetailSkeleton />}>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/freelancers" element={<FreelancerDirectory />} />
              <Route path="/post" element={<PostJob />} />
              <Route path="/activity" element={<Activity />} />
              <Route path="/jobs/:id" element={<JobDetail />} />
              <Route path="/jobs/:id/receipt" element={<Receipt />} />
              <Route path="/profile/:address" element={<Profile />} />
              {/* Last route: React Router picks the most specific match, so this
                  only renders when nothing above matched (issue #29). */}
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
          <Toaster />
        </BrowserRouter>
      </ToastProvider>
    </WalletProvider>
  );
}
