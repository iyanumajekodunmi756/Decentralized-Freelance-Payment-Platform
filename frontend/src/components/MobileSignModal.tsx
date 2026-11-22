/**
 * MobileSignModal.tsx
 *
 * Fallback signing modal supporting SEP-0007 (web+stellar: URI scheme) and QR codes (issue #312).
 * Enables users on mobile or desktop to sign transactions using mobile wallets (LOBSTR, Solar, etc.)
 * and polls the Stellar ledger for confirmation.
 */

import { useEffect, useRef, useState } from "react";
import QrCode from "./QrCode";
import { generateSep0007Uri, getTransactionHashFromXdr, pollTransaction } from "../lib/stellar";
import { useFocusTrap } from "../hooks/useFocusTrap";

interface MobileSignModalProps {
  xdr: string;
  onClose: () => void;
  onConfirmed?: (hash: string) => void;
}

export default function MobileSignModal({ xdr, onClose, onConfirmed }: MobileSignModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const [confirmedHash, setConfirmedHash] = useState<string | null>(null);
  const [statusText, setStatusText] = useState("Waiting for mobile wallet signature…");

  useFocusTrap({
    containerRef: modalRef,
    isOpen: true,
    onEscape: onClose,
  });

  const uri = generateSep0007Uri(xdr);
  const txHash = getTransactionHashFromXdr(xdr);

  useEffect(() => {
    let active = true;
    if (!txHash) return;

    // Poll the ledger for confirmation if the user submits via mobile wallet
    pollTransaction(txHash, 40, 2000)
      .then((res) => {
        if (!active) return;
        if (res.status === "SUCCESS") {
          setConfirmedHash(txHash);
          setStatusText("Transaction confirmed on ledger!");
          onConfirmed?.(txHash);
          setTimeout(() => {
            if (active) onClose();
          }, 2000);
        }
      })
      .catch(() => {
        // Polling timeout or pending
      });

    return () => {
      active = false;
    };
  }, [txHash, onConfirmed, onClose]);

  return (
    <div
      ref={modalRef}
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mobile-sign-title"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0, 0, 0, 0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: "1rem",
      }}
    >
      <div
        className="modal-card"
        style={{
          background: "var(--card-bg, #1e293b)",
          color: "var(--text, #f8fafc)",
          borderRadius: "0.75rem",
          padding: "1.5rem",
          maxWidth: "420px",
          width: "100%",
          boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.5)",
          textAlign: "center",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <h3 id="mobile-sign-title" style={{ margin: 0, fontSize: "1.25rem" }}>
            Sign on Mobile (SEP-0007)
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            style={{
              background: "none",
              border: "none",
              fontSize: "1.25rem",
              cursor: "pointer",
              color: "inherit",
            }}
          >
            ✕
          </button>
        </div>

        <p style={{ fontSize: "0.9rem", color: "var(--text-muted, #94a3b8)", marginBottom: "1.25rem" }}>
          Scan the QR code with a Stellar mobile wallet (e.g., LOBSTR, Solar) or tap below to open your mobile wallet.
        </p>

        <div
          style={{
            display: "flex",
            justifyContent: "center",
            padding: "1rem",
            background: "#ffffff",
            borderRadius: "0.5rem",
            margin: "0 auto 1.25rem auto",
            width: "fit-content",
          }}
        >
          <QrCode value={uri} label="SEP-0007 Transaction Signing QR" size={180} />
        </div>

        <div style={{ marginBottom: "1.25rem" }}>
          <a
            href={uri}
            className="button"
            style={{
              display: "inline-block",
              width: "100%",
              padding: "0.6rem 1rem",
              textAlign: "center",
              borderRadius: "0.5rem",
              background: "#3b82f6",
              color: "#ffffff",
              textDecoration: "none",
              fontWeight: 500,
              boxSizing: "border-box",
            }}
          >
            Open in Mobile Wallet
          </a>
        </div>

        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          style={{
            fontSize: "0.85rem",
            padding: "0.5rem",
            borderRadius: "0.375rem",
            background: confirmedHash ? "rgba(34, 197, 94, 0.2)" : "rgba(148, 163, 184, 0.1)",
            color: confirmedHash ? "#4ade80" : "inherit",
          }}
        >
          {confirmedHash ? "✓ " : "⏳ "}
          {statusText}
        </div>
      </div>
    </div>
  );
}
