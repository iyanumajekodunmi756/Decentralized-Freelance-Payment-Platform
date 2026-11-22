import { useEffect, useRef } from "react";

export interface UseFocusTrapOptions {
  containerRef: React.RefObject<HTMLElement | null>;
  isOpen: boolean;
  onEscape?: () => void;
  restoreFocus?: boolean;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  autoFocus?: boolean;
}

const FOCUSABLE_SELECTOR = [
  'a[href]:not([tabindex="-1"])',
  'area[href]:not([tabindex="-1"])',
  'input:not([disabled]):not([type="hidden"]):not([tabindex="-1"])',
  'select:not([disabled]):not([tabindex="-1"])',
  'textarea:not([disabled]):not([tabindex="-1"])',
  'button:not([disabled]):not([tabindex="-1"])',
  'iframe:not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]:not([tabindex="-1"])',
].join(", ");

export function useFocusTrap({
  containerRef,
  isOpen,
  onEscape,
  restoreFocus = true,
  initialFocusRef,
  autoFocus = true,
}: UseFocusTrapOptions): void {
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    // Capture the element that had focus when the modal/drawer opened
    triggerRef.current = (document.activeElement as HTMLElement) || null;

    const getFocusableElements = (): HTMLElement[] => {
      if (!containerRef.current) return [];
      const elements = Array.from(
        containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      return elements.filter((el) => {
        return (
          el.getAttribute("aria-hidden") !== "true" &&
          !el.hasAttribute("disabled") &&
          el.tabIndex !== -1
        );
      });
    };

    // Focus initial element or first focusable
    const focusInitial = () => {
      if (initialFocusRef?.current) {
        initialFocusRef.current.focus();
      } else if (autoFocus) {
        const focusable = getFocusableElements();
        if (focusable.length > 0) {
          focusable[0].focus();
        } else if (containerRef.current) {
          if (!containerRef.current.hasAttribute("tabindex")) {
            containerRef.current.setAttribute("tabindex", "-1");
          }
          containerRef.current.focus();
        }
      }
    };

    focusInitial();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onEscape?.();
        return;
      }

      if (e.key === "Tab") {
        const focusable = getFocusableElements();
        if (focusable.length === 0) {
          e.preventDefault();
          return;
        }

        const firstElement = focusable[0];
        const lastElement = focusable[focusable.length - 1];
        const activeElement = document.activeElement;

        if (e.shiftKey) {
          // Backward tab: if on first element or outside modal, cycle to last
          if (activeElement === firstElement || !containerRef.current?.contains(activeElement)) {
            e.preventDefault();
            lastElement.focus();
          }
        } else {
          // Forward tab: if on last element or outside modal, cycle to first
          if (activeElement === lastElement || !containerRef.current?.contains(activeElement)) {
            e.preventDefault();
            firstElement.focus();
          }
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      if (
        restoreFocus &&
        triggerRef.current &&
        typeof triggerRef.current.focus === "function" &&
        document.contains(triggerRef.current)
      ) {
        triggerRef.current.focus();
      }
    };
  }, [isOpen, onEscape, restoreFocus, autoFocus, containerRef, initialFocusRef]);
}
