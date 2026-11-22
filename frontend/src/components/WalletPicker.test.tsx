import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import WalletPicker from "./WalletPicker";
import * as wallets from "../lib/wallets";
import type { WalletId } from "../lib/wallets";

vi.mock("../lib/wallets", () => ({
  detectWallets: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("WalletPicker accessibility (issue #260)", () => {
  it("does not render when open is false", () => {
    render(<WalletPicker open={false} onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders with role='dialog' and traps keyboard focus", async () => {
    vi.mocked(wallets.detectWallets).mockResolvedValue([
      {
        adapter: {
          id: "freighter" as WalletId,
          name: "Freighter",
          installUrl: "https://freighter.app",
          isAvailable: async () => true,
          connect: async () => "GCLIENT",
          signTransaction: async () => "",
        },
        available: true,
      },
    ]);

    const onClose = vi.fn();
    render(<WalletPicker open={true} onSelect={vi.fn()} onClose={onClose} />);

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText("Connect Freighter")).toBeTruthy();
    });

    const closeBtn = screen.getByRole("button", { name: "Close wallet picker" });
    const connectBtn = screen.getByRole("button", { name: "Connect Freighter" });

    // Focus last element
    connectBtn.focus();
    expect(document.activeElement).toBe(connectBtn);

    // Tab wraps to closeBtn
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(closeBtn);

    // Shift+Tab wraps back to connectBtn
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(connectBtn);

    // Escape closes picker
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
