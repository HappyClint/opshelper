"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export type FileContextMenuItem =
  | { divider: true }
  | {
      divider?: false;
      label: string;
      icon?: ReactNode;
      danger?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    };

export interface FileContextMenuProps {
  position: { x: number; y: number } | null;
  items: FileContextMenuItem[];
  onClose: () => void;
}

export function FileContextMenu({ position, items, onClose }: FileContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [resolvedPos, setResolvedPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!position) {
      setResolvedPos(null);
      return;
    }
    const node = menuRef.current;
    if (!node) {
      setResolvedPos({ left: position.x, top: position.y });
      return;
    }
    const rect = node.getBoundingClientRect();
    const margin = 4;
    let left = position.x;
    let top = position.y;
    if (left + rect.width + margin > window.innerWidth) {
      left = Math.max(margin, window.innerWidth - rect.width - margin);
    }
    if (top + rect.height + margin > window.innerHeight) {
      top = Math.max(margin, window.innerHeight - rect.height - margin);
    }
    setResolvedPos({ left, top });
  }, [position]);

  useEffect(() => {
    if (!position) return;
    function handlePointerDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    function handleScroll() {
      onClose();
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKey);
    window.addEventListener("resize", handleScroll);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKey);
      window.removeEventListener("resize", handleScroll);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [position, onClose]);

  if (!position) return null;

  const style = resolvedPos
    ? { left: resolvedPos.left, top: resolvedPos.top }
    : { left: position.x, top: position.y, visibility: "hidden" as const };

  return (
    <div
      ref={menuRef}
      className="file-context-menu"
      role="menu"
      style={style}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) => {
        if ("divider" in item && item.divider) {
          return <div key={`divider-${index}`} className="file-context-menu-divider" role="separator" />;
        }
        const entry = item as Exclude<FileContextMenuItem, { divider: true }>;
        return (
          <button
            key={`${entry.label}-${index}`}
            type="button"
            role="menuitem"
            className={`file-context-menu-item${entry.danger ? " file-context-menu-item-danger" : ""}`}
            disabled={entry.disabled}
            onClick={() => {
              onClose();
              entry.onSelect();
            }}
          >
            {entry.icon ? <span className="file-context-menu-icon" aria-hidden="true">{entry.icon}</span> : null}
            <span className="file-context-menu-label">{entry.label}</span>
          </button>
        );
      })}
    </div>
  );
}
