import { render, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { useRef, useState } from "react";
import { useFocusTrap } from "./useFocusTrap";

function TrapDemo({
  isOpen,
  onEscape,
  restoreFocus = true,
}: {
  isOpen: boolean;
  onEscape?: () => void;
  restoreFocus?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap({
    containerRef,
    isOpen,
    onEscape,
    restoreFocus,
  });

  if (!isOpen) return null;

  return (
    <div ref={containerRef} role="dialog" aria-modal="true">
      <button type="button" id="btn-1">
        First
      </button>
      <input type="text" id="input-2" placeholder="Second" />
      <button type="button" id="btn-disabled" disabled>
        Disabled
      </button>
      <button type="button" id="btn-3">
        Third
      </button>
    </div>
  );
}

function HostApp() {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <div>
      <button type="button" id="open-btn" onClick={() => setIsOpen(true)}>
        Open Modal
      </button>
      <TrapDemo isOpen={isOpen} onEscape={() => setIsOpen(false)} />
    </div>
  );
}

describe("useFocusTrap hook", () => {
  afterEach(() => {
    cleanup();
  });

  it("sets initial focus to the first enabled focusable element inside container", () => {
    const { getByRole } = render(<TrapDemo isOpen={true} />);
    const firstBtn = getByRole("button", { name: "First" });
    expect(document.activeElement).toBe(firstBtn);
  });

  it("traps focus forward: pressing Tab on last focusable element wraps to the first", () => {
    const { getByRole } = render(<TrapDemo isOpen={true} />);
    const firstBtn = getByRole("button", { name: "First" });
    const thirdBtn = getByRole("button", { name: "Third" });

    // Focus last enabled element
    thirdBtn.focus();
    expect(document.activeElement).toBe(thirdBtn);

    // Press Tab
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(firstBtn);
  });

  it("traps focus backward: pressing Shift+Tab on first element wraps to the last", () => {
    const { getByRole } = render(<TrapDemo isOpen={true} />);
    const firstBtn = getByRole("button", { name: "First" });
    const thirdBtn = getByRole("button", { name: "Third" });

    firstBtn.focus();
    expect(document.activeElement).toBe(firstBtn);

    // Press Shift+Tab
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(thirdBtn);
  });

  it("calls onEscape when Escape key is pressed", () => {
    const onEscape = vi.fn();
    render(<TrapDemo isOpen={true} onEscape={onEscape} />);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("restores focus to triggering element when modal closes", () => {
    const { getByRole } = render(<HostApp />);
    const openBtn = getByRole("button", { name: "Open Modal" });

    openBtn.focus();
    expect(document.activeElement).toBe(openBtn);

    // Click open
    fireEvent.click(openBtn);

    // Focus is now inside modal
    const firstBtn = getByRole("button", { name: "First" });
    expect(document.activeElement).toBe(firstBtn);

    // Press Escape to close
    fireEvent.keyDown(window, { key: "Escape" });

    // Focus returns to openBtn
    expect(document.activeElement).toBe(openBtn);
  });
});
