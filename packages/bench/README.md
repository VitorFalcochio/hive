# Hive Bench

Mede o que os agentes do Hive conseguem fazer, com tarefas fixas e notas objetivas. Responde à pergunta "até onde ele vai?" com números, por modelo, e mostra se uma mudança no Hive melhorou ou piorou os agentes.

## Como funciona

- `fixture/` é um projeto de exemplo (uma pequena loja em TypeScript, sem dependências, testado com `node --test`).
- `src/tasks.ts` define 12 tarefas em 4 níveis:
  1. edição trivial
  2. correção de bug
  3. função pequena em 1 ou 2 arquivos
  4. função que mexe em vários arquivos
- Cada tarefa roda numa cópia nova do projeto, com o agente **Backend Developer padrão do Hive** (`NativeAgentRuntime`, as mesmas ferramentas e skills do app). Não há Queen nem scheduler: o bench mede o núcleo do agente.
- A nota vem de `checks/<tarefa>.check.ts`, um teste escondido que o agente nunca vê, mais os testes originais do projeto (para pegar regressões). Os testes que o próprio agente escreve não contam.
- `solutions/<tarefa>/` guarda uma solução de referência. `src/bench.test.ts` (roda no `npm test`) garante que cada verificação falha no projeto original e passa com a solução: a tarefa é real e a nota é justa.
- Comandos: só os de leitura do Hive, mais `npm test` e `node --test`. O resto é negado, como no Modo Turno.

## Rodar

    npm run bench                                     # todas as tarefas, modelos dos agentes do Hive
    npm run bench -- --level 1,2                      # só alguns níveis
    npm run bench -- --tasks cupons,estoque           # só algumas tarefas
    npm run bench -- --models modelo-a,modelo-b       # outros modelos do mesmo provedor
    npm run bench -- --label depois --compare latest  # compara com a rodada anterior

Outras opções: `--provider <id>`, `--timeout-min 15`, `--max-steps 60`, `--keep` (mantém as cópias de trabalho em `%TEMP%/hive-bench`).

Por padrão, o provedor, a chave e os modelos vêm do próprio Hive (`%APPDATA%/Hive`). O bench roda no Electron para ler a chave sem exibi-la. Para usar outro provedor, defina `HIVE_BENCH_BASE_URL`, `HIVE_BENCH_API_KEY` e, se precisar, `HIVE_BENCH_KIND`, e informe `--models`.

Os resultados ficam em `.local/bench/<data>-<label>/`, com `report.md` (o relatório) e `results.json` (os números de cada tarefa).

## O que o relatório mede

- **Resolvidas:** o teste escondido passou e nada quebrou.
- **Disse que terminou sem ter feito:** o agente declarou sucesso, mas a verificação falhou. É o número mais importante para a confiança.
- Tempo, chamadas ao modelo, tokens enviados, edições que falharam, erros de ferramenta, comandos negados e tempo de espera por erros do provedor (429, timeout).

## Adicionar uma tarefa

1. Acrescente a tarefa em `src/tasks.ts`.
2. Crie `checks/<id>.check.ts` (um teste `node:test` que importa de `../src/...`).
3. Crie `solutions/<id>/` só com os arquivos que mudam.
4. `npm test` confirma que a verificação falha sem a solução e passa com ela.
