type AnchorRect = {
  top: number;
  bottom: number;
  left: number;
  right: number;
};

// Prefer the conversation's right edge; narrow screens use the space below/above it.
export function anchoredConfirmPosition(
  anchor: AnchorRect,
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
) {
  const gap = 8;
  const margin = 12;
  const fitsRight = anchor.right + gap + panel.width <= viewport.width - margin;
  const left = fitsRight ? anchor.right + gap : anchor.right - panel.width;
  const top = fitsRight
    ? anchor.top
    : anchor.bottom + gap + panel.height <= viewport.height - margin
      ? anchor.bottom + gap
      : anchor.top - gap - panel.height;
  return {
    left: Math.max(margin, Math.min(left, viewport.width - panel.width - margin)),
    top: Math.max(margin, Math.min(top, viewport.height - panel.height - margin)),
  };
}
