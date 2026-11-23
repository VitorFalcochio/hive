import { useEffect, useState } from 'react';
import { RotateCcw, SlidersHorizontal } from 'lucide-react';
import {
  beeColorName,
  beeHex,
  beeSwatchFamilies,
  hexToHsl,
  hslToHex,
  normalizeHex,
  type BeeColorValue,
} from '@hive/core';
import { Mascot } from './mascot';

const RECENT_KEY = 'hive.recentBeeColors';
const RECENT_LIMIT = 8;

/** Colours picked lately on this machine, newest first; a convenience, so it may be empty. */
export function recentBeeColors(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(stored)
      ? stored.map((item) => normalizeHex(String(item))).filter((hex): hex is string => !!hex)
      : [];
  } catch {
    return [];
  }
}

function remember(hex: string): string[] {
  const next = [hex, ...recentBeeColors().filter((item) => item !== hex)].slice(0, RECENT_LIMIT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage off (private window, blocked): the list just is not kept.
  }
  return next;
}

/**
 * The colour of an agent's bee: the palette by family, colours used lately, any colour as HEX or
 * by hue, saturation and lightness, and a way back to the role's colour. `fallback` is what the
 * bee wears with no pick; choosing it stores no pick, so the bee keeps following its role.
 */
export function BeeColorPicker({
  value,
  fallback,
  onChange,
}: {
  value: BeeColorValue | null;
  fallback: string;
  onChange: (color: string | null) => void;
}) {
  const current = value ? beeHex(value) : fallback;
  const [recent, setRecent] = useState(recentBeeColors);
  const [custom, setCustom] = useState(false);
  const [typed, setTyped] = useState(current);
  // The HEX field follows the colour picked elsewhere (a swatch, the sliders).
  useEffect(() => setTyped(current), [current]);
  const invalid = normalizeHex(typed) === null;
  const hsl = hexToHsl(current);

  /** `keep` adds the colour to the recent ones; a slider being dragged only previews it. */
  const pick = (hex: string, keep = true) => {
    const color = normalizeHex(hex);
    if (!color) return;
    if (keep) keepRecent(color);
    onChange(color === fallback.toUpperCase() ? null : color);
  };
  const keepRecent = (color: string) => {
    if (color !== fallback.toUpperCase()) setRecent(remember(color));
  };

  const swatch = (hex: string, label: string) => (
    <button
      key={hex}
      type="button"
      role="radio"
      aria-checked={hex === current}
      aria-label={label}
      title={`${label} · ${hex}`}
      className={hex === current ? 'bee-swatch selected' : 'bee-swatch'}
      style={{ background: hex }}
      onClick={() => pick(hex)}
    />
  );

  return (
    <div className="bee-picker">
      <span className="bee-picker-preview" aria-hidden>
        <Mascot size={44} color={current} />
      </span>
      <div className="bee-picker-body">
        <span className="bee-picker-label">
          Cor da abelha · {beeColorName(current)} <code className="bee-hex">{current}</code>
          {value === null && <span className="optional"> (da função)</span>}
        </span>
        <div className="bee-families" role="radiogroup" aria-label="Cor da abelha">
          {beeSwatchFamilies.map((family) => (
            <div key={family.label} className="bee-swatches" role="group" aria-label={family.label}>
              {family.swatches.map((item) => swatch(item.hex, item.label))}
            </div>
          ))}
        </div>
        {recent.length > 0 && (
          <div className="bee-swatches bee-recent" role="group" aria-label="Cores recentes">
            <span className="bee-recent-label">Recentes</span>
            {recent.map((hex) => swatch(hex, `${beeColorName(hex)} (recente)`))}
          </div>
        )}
        <div className="bee-picker-actions">
          <button
            type="button"
            className="ghost"
            aria-expanded={custom}
            onClick={() => setCustom(!custom)}
          >
            <SlidersHorizontal size={13} /> Personalizar
          </button>
          {value !== null && (
            <button type="button" className="ghost" onClick={() => onChange(null)}>
              <RotateCcw size={13} /> Cor da função
            </button>
          )}
        </div>
        {custom && (
          <div className="bee-custom">
            <label className="bee-hex-field">
              HEX
              <input
                value={typed}
                maxLength={7}
                spellCheck={false}
                aria-invalid={invalid}
                aria-describedby={invalid ? 'bee-hex-error' : undefined}
                onChange={(event) => {
                  setTyped(event.target.value);
                  // Only a full #RRGGBB while typing: "#38B" is on its way to "#38BDF8".
                  if (/^#?[0-9a-f]{6}$/i.test(event.target.value.trim())) pick(event.target.value);
                }}
                onBlur={() => {
                  const color = normalizeHex(typed);
                  if (color) pick(color);
                  else setTyped(current);
                }}
              />
            </label>
            {invalid && (
              <span id="bee-hex-error" className="bee-field-error">
                Use uma cor no formato #RRGGBB, como #38BDF8.
              </span>
            )}
            {(
              [
                ['h', 'Matiz', 360],
                ['s', 'Saturação', 100],
                ['l', 'Luz', 100],
              ] as const
            ).map(([key, label, max]) => (
              <label key={key} className="bee-slider">
                <span>
                  {label} <span className="optional">{hsl[key]}</span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={max}
                  value={hsl[key]}
                  onChange={(event) =>
                    pick(hslToHex({ ...hsl, [key]: Number(event.target.value) }), false)
                  }
                  // Let go (mouse, touch or keys): the colour reached counts as one recent.
                  onPointerUp={() => keepRecent(current)}
                  onKeyUp={() => keepRecent(current)}
                />
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
