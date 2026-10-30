export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a window was left: its normal (unmaximized) bounds and whether it was maximized. */
export interface WindowPlacement {
  bounds: Rect;
  maximized: boolean;
}

/** Enough of the title bar must land on a screen for the window to be grabbed and moved. */
const MIN_VISIBLE = { width: 160, height: 48 };

/** Reads a stored placement; anything malformed is treated as never saved. */
export function parsePlacement(raw: string | null): WindowPlacement | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<WindowPlacement>;
    const bounds = value.bounds;
    const numbers =
      bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite);
    if (!numbers || bounds.width <= 0 || bounds.height <= 0) return null;
    return { bounds, maximized: value.maximized === true };
  } catch {
    return null;
  }
}

/**
 * The saved bounds when they still fit on one of the current screens (a monitor may have been
 * unplugged since), shrunk to that screen when larger; null lets the window open centred.
 */
export function restoreBounds(
  saved: Rect,
  workAreas: Rect[],
  minimum: { width: number; height: number },
): Rect | null {
  for (const area of workAreas) {
    // The top strip is what the user drags; it has to be reachable.
    const left = Math.max(saved.x, area.x);
    const right = Math.min(saved.x + saved.width, area.x + area.width);
    const top = Math.max(saved.y, area.y);
    const bottom = Math.min(saved.y + MIN_VISIBLE.height, area.y + area.height);
    if (right - left < MIN_VISIBLE.width || bottom - top < MIN_VISIBLE.height / 2) continue;
    const width = Math.max(minimum.width, Math.min(saved.width, area.width));
    const height = Math.max(minimum.height, Math.min(saved.height, area.height));
    return {
      x: Math.min(Math.max(saved.x, area.x), area.x + area.width - width),
      y: Math.min(Math.max(saved.y, area.y), area.y + area.height - height),
      width,
      height,
    };
  }
  return null;
}
