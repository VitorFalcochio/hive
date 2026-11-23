/** Colour helpers for the bee colour picker: typed HEX values and hue/saturation/lightness. */

/**
 * A colour typed by someone as `#RRGGBB`, upper case; `#RGB` and a missing `#` are accepted.
 * Null when it is not a colour.
 */
export function normalizeHex(input: string): string | null {
  const value = input.trim().replace(/^#/, '');
  const full = /^[0-9a-f]{3}$/i.test(value) ? [...value].map((c) => c + c).join('') : value;
  return /^[0-9a-f]{6}$/i.test(full) ? `#${full.toUpperCase()}` : null;
}

/** Hue 0-360, saturation and lightness 0-100. */
export interface Hsl {
  h: number;
  s: number;
  l: number;
}

/** The hue, saturation and lightness of `#RRGGBB`, rounded to whole numbers. */
export function hexToHsl(hex: string): Hsl {
  const value = parseInt((normalizeHex(hex) ?? '#000000').slice(1), 16);
  const r = ((value >> 16) & 255) / 255;
  const g = ((value >> 8) & 255) / 255;
  const b = (value & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

/** `#RRGGBB` of a hue, saturation and lightness; out-of-range values are clamped. */
export function hslToHex({ h, s, l }: Hsl): string {
  const hue = (((h % 360) + 360) % 360) / 60;
  const sat = Math.min(100, Math.max(0, s)) / 100;
  const light = Math.min(100, Math.max(0, l)) / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs((hue % 2) - 1));
  const m = light - c / 2;
  const [r, g, b] =
    hue < 1
      ? [c, x, 0]
      : hue < 2
        ? [x, c, 0]
        : hue < 3
          ? [0, c, x]
          : hue < 4
            ? [0, x, c]
            : hue < 5
              ? [x, 0, c]
              : [c, 0, x];
  const channel = (value: number) =>
    Math.round((value + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`.toUpperCase();
}
