import { useEffect, useState } from 'react';
import { HiveField } from './home-field';
import { HoneyComb } from './honey';

/** How long the loading screen stays at least, so its opening wave plays instead of flashing. */
export const SPLASH_MIN_MS = import.meta.env.MODE === 'test' ? 0 : 3000;
/** How long it takes to fade away once Hive is ready. */
export const SPLASH_LEAVE_MS = import.meta.env.MODE === 'test' ? 0 : 520;

/**
 * The loading screen's phase: `on` while Hive loads (and for the minimum time), `leaving` while it
 * fades over the ready app, then `off`.
 */
export function useSplash(loading: boolean): 'on' | 'leaving' | 'off' {
  const [minDone, setMinDone] = useState(SPLASH_MIN_MS === 0);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (minDone) return;
    const timer = setTimeout(() => setMinDone(true), SPLASH_MIN_MS);
    return () => clearTimeout(timer);
  }, [minDone]);
  const leaving = !loading && minDone;
  useEffect(() => {
    if (!leaving || gone) return;
    const timer = setTimeout(() => setGone(true), SPLASH_LEAVE_MS);
    return () => clearTimeout(timer);
  }, [leaving, gone]);
  return gone ? 'off' : leaving ? 'leaving' : 'on';
}

/**
 * Shown while Hive loads, so the window never opens blank: the home screen's honeycomb field
 * opening from the centre, with the comb, the name and a honey progress bar on top. `leaving`
 * fades it away over the app once everything is ready.
 */
export function SplashScreen({ leaving = false }: { leaving?: boolean }) {
  return (
    <div
      className={leaving ? 'splash leaving' : 'splash'}
      role="status"
      aria-live="polite"
      aria-busy={!leaving}
      aria-hidden={leaving || undefined}
    >
      <HiveField variant="splash" />
      <div className="splash-glow" aria-hidden="true" />
      <div className="splash-center">
        <div className="splash-mark" aria-hidden="true">
          <HoneyComb size={54} />
        </div>
        <p className="splash-title">hive</p>
        <p className="splash-caption">{leaving ? 'Pronto.' : 'Carregando o Hive…'}</p>
        <div className="splash-track" aria-hidden="true">
          <span className="splash-bar" />
        </div>
      </div>
    </div>
  );
}
