/**
 * WalletPicker.tsx
 *
 * Modal shown when connecting without a specific wallet. It probes the
 * adapters in `lib/wallets.ts` and lets the user pick one; wallets that are not
 * installed link to their install page instead of offering a dead button.
 */

import { useEffect, useRef, useState } from "react";
import {
  detectWallets,
  type DetectedWallet,
  type WalletId,
} from "../lib/wallets";
import { useFocusTrap } from "../hooks/useFocusTrap";

export interface WalletPickerProps {
  open: boolean;
  onSelect: (walletId: WalletId) => void;
  onClose: () => void;
}

export default function WalletPicker({ open, onSelect, onClose }: WalletPickerProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const [wallets, setWallets] = useState<DetectedWallet[] | null>(null);

  useFocusTrap({
    containerRef: modalRef,
    isOpen: open,
    onEscape: onClose,
  });

  // Probe availability each time the picker opens (an extension may have been
  // installed since the last attempt).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setWallets(null);
    void detectWallets().then((found) => {
      if (!cancelled) setWallets(found);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="wallet-picker-title"
        className="modal card"
        onClick={(e) => e.stopPropagation()}
      >
        <div role="status" aria-live="polite" className="sr-only">
          {wallets === null
            ? "Detecting wallets…"
            : `${wallets.filter((w) => w.available).length} wallets available`}
        </div>
        <div className="modal-header">
          <h2 id="wallet-picker-title">Connect a wallet</h2>
          <button type="button" onClick={onClose} aria-label="Close wallet picker">
            ×
          </button>
        </div>
        <p className="muted">Choose the Stellar wallet you want to sign with.</p>

        {wallets === null ? (
          <p>Detecting wallets…</p>
        ) : (
          <ul className="wallet-list">
            {wallets.map(({ adapter, available }) => (
              <li key={adapter.id}>
                <div>
                  <strong>{adapter.name}</strong>
                  {available ? (
                    <span className="muted"> — detected</span>
                  ) : (
                    <span className="muted"> — not installed</span>
                  )}
                </div>
                {available ? (
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => onSelect(adapter.id)}
                  >
                    Connect {adapter.name}
                  </button>
                ) : (
                  <a href={adapter.installUrl} target="_blank" rel="noreferrer">
                    Install {adapter.name}
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}

        <p className="muted">
          The app never sees your private keys — every wallet signs in its own
          extension or app.
        </p>
      </div>
    </div>
  );
}
