import { Hexagon } from 'lucide-react';

// Shown until the first dashboard load finishes, so the window never opens blank.
export function SplashScreen() {
  return (
    <div className="splash" role="status" aria-live="polite">
      <div className="splash-mark" aria-hidden="true">
        <Hexagon size={44} strokeWidth={2} />
      </div>
      <p className="splash-title">hive</p>
      <p className="splash-caption">Carregando o Hive…</p>
      <div className="splash-track" aria-hidden="true">
        <span className="splash-bar" />
      </div>
    </div>
  );
}
