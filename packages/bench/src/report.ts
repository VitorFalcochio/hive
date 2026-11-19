import type { BenchResult } from './runner';

const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : '–');
const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
};
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const minutes = (seconds: number) =>
  seconds < 90 ? `${seconds}s` : `${(seconds / 60).toFixed(1)} min`;
const thousands = (tokens: number) => `${Math.round(tokens / 1000)}k`;

/** One verdict per result: the task was done, cleanly. */
export const solved = (r: BenchResult) => r.passed && r.noRegressions;

function levelTable(results: BenchResult[]): string[] {
  const lines = [
    '| Nível | Resolvidas | Tempo (mediana) | Chamadas ao modelo (mediana) | Tokens enviados (mediana) |',
    '|---|---|---|---|---|',
  ];
  for (const level of [1, 2, 3, 4]) {
    const group = results.filter((r) => r.level === level);
    if (!group.length) continue;
    const ok = group.filter(solved).length;
    lines.push(
      `| ${level} | ${ok}/${group.length} (${pct(ok, group.length)}) | ${minutes(median(group.map((r) => r.seconds)))} | ${median(group.map((r) => r.modelCalls))} | ${thousands(median(group.map((r) => r.promptTokens)))} |`,
    );
  }
  return lines;
}

/**
 * What the measured runs say about context: the prompt cache and how much tool output reached
 * the prompt. Only facts; no saving is inferred from them without a run to compare against.
 */
export function contextLines(results: BenchResult[]): string[] {
  const measured = results.filter((r) => r.metrics);
  if (!measured.length) return [];
  const prompt = sum(measured.map((r) => r.promptTokens));
  const reported = measured.filter((r) => r.cachedTokens !== null);
  const cached = sum(reported.map((r) => r.cachedTokens ?? 0));
  const cache = reported.length
    ? `${thousands(cached)} de ${thousands(sum(reported.map((r) => r.promptTokens)))} tokens enviados vieram do cache do provedor`
    : 'o provedor não informou cache';
  const raw = sum(measured.map((r) => r.rawToolChars));
  const sent = sum(measured.map((r) => r.sentToolChars));
  return [
    `- Contexto (${measured.length} tarefas medidas, ${thousands(prompt)} tokens enviados): ${cache}`,
    `- Saída das ferramentas: ${thousands(raw)} caracteres produzidos, ${thousands(sent)} levados ao prompt (${pct(sent, raw)}) · recuperações com read_output: ${sum(measured.map((r) => r.recoveries))}`,
  ];
}

function verdict(r: BenchResult): string {
  if (solved(r)) return '✅ resolvida';
  if (r.passed) return '⚠️ fez, mas quebrou outra coisa';
  if (r.agentStatus === 'completed') return '❌ disse que terminou, mas não fez';
  return `❌ ${r.agentStatus === 'error' ? 'erro' : 'falhou'}${r.agentError ? `: ${r.agentError.slice(0, 80)}` : ''}`;
}

export function renderReport(
  results: BenchResult[],
  meta: { label: string; startedAt: string; limits: string },
  previous?: BenchResult[],
): string {
  const models = [...new Set(results.map((r) => r.model))];
  const out: string[] = [
    `# Hive Bench: ${meta.label}`,
    '',
    `Início: ${meta.startedAt} · Limites: ${meta.limits}`,
    '',
  ];
  for (const model of models) {
    const mine = results.filter((r) => r.model === model);
    const ok = mine.filter(solved).length;
    out.push(`## ${model}`, '');
    out.push(
      `**${ok} de ${mine.length} tarefas resolvidas (${pct(ok, mine.length)})** · tempo total ${minutes(sum(mine.map((r) => r.seconds)))} · ${sum(mine.map((r) => r.modelCalls))} chamadas · ${thousands(sum(mine.map((r) => r.promptTokens)))} tokens enviados`,
      '',
    );
    const waits = sum(mine.map((r) => r.retryWaitSeconds));
    const lies = mine.filter((r) => !r.passed && r.agentStatus === 'completed').length;
    out.push(
      `- Espera por erro do provedor (429, timeout): ${minutes(waits)} em ${sum(mine.map((r) => r.providerRetries))} tentativas`,
      `- Edições que falharam: ${sum(mine.map((r) => r.failedEdits))} · erros de ferramenta: ${sum(mine.map((r) => r.toolErrors))} · comandos negados: ${sum(mine.map((r) => r.commandsDenied))}`,
      `- Disse que terminou sem ter feito: ${lies} de ${mine.length}`,
      ...contextLines(mine),
      '',
      ...levelTable(mine),
      '',
      '| Tarefa | Nível | Resultado | Tempo | Chamadas | Edições falhas | Espera do provedor |',
      '|---|---|---|---|---|---|---|',
    );
    for (const r of mine) {
      const before = previous?.find((p) => p.model === r.model && p.taskId === r.taskId);
      const change =
        before && solved(before) !== solved(r) ? (solved(r) ? ' (antes ❌)' : ' (antes ✅)') : '';
      out.push(
        `| ${r.taskId} | ${r.level} | ${verdict(r)}${change} | ${minutes(r.seconds)} | ${r.modelCalls} | ${r.failedEdits} | ${minutes(r.retryWaitSeconds)} |`,
      );
    }
    if (previous) {
      const old = previous.filter((p) => p.model === model);
      if (old.length)
        out.push(
          '',
          `Comparado à rodada anterior: ${old.filter(solved).length}/${old.length} → ${ok}/${mine.length} resolvidas; tempo total ${minutes(sum(old.map((r) => r.seconds)))} → ${minutes(sum(mine.map((r) => r.seconds)))}.`,
        );
    }
    out.push('');
  }
  return out.join('\n');
}
