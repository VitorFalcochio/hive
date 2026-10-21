import type { DashboardSummary } from '@hive/core';

const compact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
const full = new Intl.NumberFormat('pt-BR');

/** Today's token use in the status bar: a thin honey bar filling up towards the daily budget. */
export function TokenMeter({ usage }: { usage: DashboardSummary['today'] }) {
  const used = usage.promptTokens + usage.completionTokens;
  const detail = `Hoje: ${full.format(used)} tokens (${full.format(usage.promptTokens)} de entrada, ${full.format(usage.completionTokens)} de saída)`;

  if (!usage.budget)
    return (
      <span className="token-meter" title={detail}>
        {compact.format(used)} tokens hoje
      </span>
    );

  const ratio = used / usage.budget;
  return (
    <span
      className={ratio >= 1 ? 'token-meter over' : 'token-meter'}
      title={`${detail} de ${full.format(usage.budget)} do orçamento diário`}
    >
      <span
        className="token-track"
        role="meter"
        aria-label="Tokens usados hoje"
        aria-valuemin={0}
        aria-valuemax={usage.budget}
        aria-valuenow={used}
      >
        <span className="token-fill" style={{ width: `${Math.min(100, ratio * 100)}%` }} />
      </span>
      {compact.format(used)} / {compact.format(usage.budget)}
    </span>
  );
}
