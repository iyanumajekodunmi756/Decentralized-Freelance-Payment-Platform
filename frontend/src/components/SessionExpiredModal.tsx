import React, { useCallback, useEffect, useState } from "react";
import { useWallet } from "../hooks/wallet-context";
import {
  authenticate,
  onSessionExpired,
  resolveSessionExpired,
  rejectSessionExpired,
} from "../lib/api";

interface SessionExpiredModalState {
  pending: boolean;
  submitting: boolean;
  error: string | null;
}

const SessionExpiredModal: React.FC = () => {
  const { publicKey, signMessage, disconnect } = useWallet();
  const [state, setState] = useState<SessionExpiredModalState>({
    pending: false,
    submitting: false,
    error: null,
  });

  useEffect(() => {
    const unsubscribe = onSessionExpired(() => {
      setState({ pending: true, submitting: false, error: null });
    });
    return unsubscribe;
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!publicKey) {
      setState((prev) => ({
        ...prev,
        error: "No connected wallet found. Please reconnect your wallet.",
      }));
      return;
    }

    setState((prev) => ({ ...prev, submitting: true, error: null }));

    try {
      const freshToken = await authenticate(publicKey, signMessage, { fresh: true });
      await resolveSessionExpired(freshToken);
      setState({ pending: false, submitting: false, error: null });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to re-authenticate. Please try again.";
      setState((prev) => ({ ...prev, submitting: false, error: message }));
    }
  }, [publicKey, signMessage]);

  const handleDismiss = useCallback(() => {
    rejectSessionExpired();
    setState({ pending: false, submitting: false, error: null });
    disconnect();
  }, [disconnect]);

  if (!state.pending) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="session-expired-title"
    >
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <h2 id="session-expired-title" className="text-lg font-semibold text-gray-900">
          Session Expired
        </h2>
        <p className="mt-2 text-sm text-gray-600">
          Your session has expired. Please sign a new challenge with your connected wallet to
          continue. Your current page and unsaved form data will be preserved.
        </p>

        {state.error && (
          <p className="mt-3 text-sm text-red-600" role="alert">
            {state.error}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            onClick={handleDismiss}
            disabled={state.submitting}
          >
            Dismiss
          </button>
          <button
            type="button"
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            onClick={handleConfirm}
            disabled={state.submitting}
          >
            {state.submitting ? "Re-authenticating…" : "Re-authenticate"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SessionExpiredModal;
