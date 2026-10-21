import { Mascot } from './mascot';

// Shown until the first dashboard load finishes, so the window never opens blank.
export function SplashScreen() {
  return (
    <div className="splash" role="status" aria-live="polite">
      <div className="splash-mark" aria-hidden="true">
        <Mascot size={88} mood="working" />
      </div>
      <p className="splash-title">hive</p>
      <p className="splash-caption">Carregando o Hive…</p>
      <div className="splash-track" aria-hidden="true">
        <span className="splash-bar" />
      </div>
    </div>
  );
}
