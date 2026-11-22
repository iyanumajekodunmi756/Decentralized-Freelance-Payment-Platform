import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import ConfirmModal from "./ConfirmModal";

function HostModalApp() {
  const [isOpen, setIsOpen] = useState(false);
  const [pending, setPending] = useState(false);

  return (
    <div>
      <button type="button" id="trigger-reclaim" onClick={() => setIsOpen(true)}>
        Reclaim funds
      </button>
      <ConfirmModal
        isOpen={isOpen}
        title="Confirm Reclaim"
        description="This will refund escrowed funds."
        amount="100.00"
        assetSymbol="USDC"
        isPending={pending}
        onConfirm={() => setPending(true)}
        onCancel={() => setIsOpen(false)}
      />
    </div>
  );
}

describe("ConfirmModal", () => {
  afterEach(() => {
    cleanup();
  });

  it("does not render when isOpen is false", () => {
    render(
      <ConfirmModal
        isOpen={false}
        title="Confirm Cancellation"
        description="Are you sure you want to cancel?"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders title, description, amount, and handles confirm/cancel clicks", () => {
    const handleConfirm = vi.fn();
    const handleCancel = vi.fn();

    render(
      <ConfirmModal
        isOpen={true}
        title="Confirm Dispute Timelock Reclaim"
        description="The dispute timelock has elapsed. Funds will be refunded."
        amount="50.00"
        assetSymbol="USDC"
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />,
    );

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Confirm Dispute Timelock Reclaim")).toBeTruthy();
    expect(
      screen.getByText("The dispute timelock has elapsed. Funds will be refunded."),
    ).toBeTruthy();
    expect(screen.getByText("50.00 USDC")).toBeTruthy();

    // Click Cancel
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(handleCancel).toHaveBeenCalledTimes(1);

    // Click Confirm
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(handleConfirm).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape key press", () => {
    const handleCancel = vi.fn();

    render(
      <ConfirmModal
        isOpen={true}
        title="Confirm Reclaim"
        description="Warning"
        onConfirm={vi.fn()}
        onCancel={handleCancel}
      />,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(handleCancel).toHaveBeenCalledTimes(1);
  });

  it("traps keyboard tab navigation within the modal", () => {
    render(
      <ConfirmModal
        isOpen={true}
        title="Confirm Reclaim"
        description="Warning"
        confirmLabel="Confirm Action"
        cancelLabel="Cancel Action"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const closeBtn = screen.getByRole("button", { name: "Close modal" });
    const cancelBtn = screen.getByRole("button", { name: "Cancel Action" });
    const confirmBtn = screen.getByRole("button", { name: "Confirm Action" });

    // Initial focus on close button (first focusable)
    expect(document.activeElement).toBe(closeBtn);

    // Tab moves focus to Cancel, then Confirm
    cancelBtn.focus();
    expect(document.activeElement).toBe(cancelBtn);

    confirmBtn.focus();
    expect(document.activeElement).toBe(confirmBtn);

    // Tab on confirm wraps back to close button
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(closeBtn);

    // Shift+Tab on close wraps back to confirm button
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirmBtn);
  });

  it("restores focus to the triggering element upon closing", () => {
    const { getByRole } = render(<HostModalApp />);
    const triggerBtn = getByRole("button", { name: "Reclaim funds" });

    triggerBtn.focus();
    expect(document.activeElement).toBe(triggerBtn);

    // Open modal
    fireEvent.click(triggerBtn);

    // Focus is now inside modal
    const closeBtn = getByRole("button", { name: "Close modal" });
    expect(document.activeElement).toBe(closeBtn);

    // Press Escape to close modal
    fireEvent.keyDown(window, { key: "Escape" });

    // Focus restored to trigger button
    expect(document.activeElement).toBe(triggerBtn);
  });

  it("announces transaction state transitions via aria-live polite region", () => {
    const { rerender } = render(
      <ConfirmModal
        isOpen={true}
        title="Confirm Reclaim"
        description="Refund details"
        isPending={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const liveRegion = screen.getByRole("status");
    expect(liveRegion.getAttribute("aria-live")).toBe("polite");
    expect(liveRegion.textContent).toContain("Confirm Reclaim. Refund details");

    // Re-render with pending state
    rerender(
      <ConfirmModal
        isOpen={true}
        title="Confirm Reclaim"
        description="Refund details"
        isPending={true}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const updatedLiveRegion = screen.getByRole("status");
    expect(updatedLiveRegion.textContent).toContain("Signing transaction… awaiting ledger confirmation");
  });
});
