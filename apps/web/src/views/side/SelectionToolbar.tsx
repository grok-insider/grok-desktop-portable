/**
 * Floating toolbar for transcript text selection → side chat (light ADR 0019).
 */

import { useEffect, useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { Button } from "../../components/ui";

export interface SelectionToolbarProps {
  /** Root that owns selectable message text (transcript column). */
  containerRef: React.RefObject<HTMLElement | null>;
  onAddToSideChat: (text: string) => void;
  disabled?: boolean;
}

interface ToolbarState {
  text: string;
  top: number;
  left: number;
}

export function SelectionToolbar({
  containerRef,
  onAddToSideChat,
  disabled = false,
}: SelectionToolbarProps) {
  const [state, setState] = useState<ToolbarState | null>(null);

  useEffect(() => {
    function clear() {
      setState(null);
    }

    function onSelectionChange() {
      if (disabled) {
        clear();
        return;
      }
      const root = containerRef.current;
      const selection = window.getSelection();
      if (root === null || selection === null || selection.isCollapsed) {
        clear();
        return;
      }
      const text = selection.toString().trim();
      if (text.length === 0 || text.length > 8 * 1024) {
        clear();
        return;
      }
      const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
      if (range === null) {
        clear();
        return;
      }
      // Only selections inside our transcript container.
      const common = range.commonAncestorContainer;
      const node = common.nodeType === Node.ELEMENT_NODE ? (common as Node) : common.parentNode;
      if (node === null || !root.contains(node)) {
        clear();
        return;
      }
      const rect = range.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        clear();
        return;
      }
      setState({
        text,
        top: rect.top - rootRect.top + root.scrollTop - 40,
        left: Math.max(8, rect.left - rootRect.left + rect.width / 2 - 70),
      });
    }

    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, [containerRef, disabled]);

  if (state === null) {
    return null;
  }

  return (
    <div
      className="pointer-events-auto absolute z-20 -translate-x-1/2"
      style={{ top: state.top, left: state.left }}
      role="toolbar"
      aria-label="Selection actions"
    >
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="shadow-overlay"
        onMouseDown={(event) => {
          // Keep selection until click handlers run.
          event.preventDefault();
        }}
        onClick={() => {
          onAddToSideChat(state.text);
          window.getSelection()?.removeAllRanges();
          setState(null);
        }}
      >
        <MessageSquarePlus size={14} aria-hidden="true" />
        Add to Side Chat
      </Button>
    </div>
  );
}
