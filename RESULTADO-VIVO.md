# Resultado Vivo e Minhas Notas — P0

O Nexus mantém as janelas dos agentes, tarefas e console existentes. O novo nó Resultado Vivo aparece à direita, pode ser movido e redimensionado e abre o relatório e a aba Minhas Notas. Suas conexões são de agregação visual; não fazem parte das dependências do scheduler. Posição e tamanho usam o layout já persistido por execução.

## Fonte de verdade e sincronização

O processo principal projeta os eventos persistidos e os resultados reais das tarefas em um relatório por execução, identificado também pela missão. A projeção funciona com a janela fechada. Mudanças são agrupadas em intervalos de 600 ms; o renderer assina notificações antes de carregar os dados, reconcilia a cada 10 segundos e ao receber foco e remove os listeners ao desmontar.

O cursor é o `seq` do SQLite, não o horário do evento. O agregador lê apenas eventos posteriores ao cursor salvo, em páginas de 500. A linha do tempo tem paginação de eventos antigos e recupera eventos novos por cursor, inclusive rajadas maiores que uma página. IDs repetidos são ignorados pela chave única da tabela original; o primeiro registro permanece intacto.

Arquivos e testes vêm dos mesmos eventos `file.changed`, `command.started`, `command.finished` e resultados de tarefas que alimentam Changed Files/Test Results. O relatório registra as referências de evento/tarefa, commit e worktree disponíveis. Código de saída zero permite marcar uma verificação como aprovada; timeout e códigos diferentes de zero indicam falha. Comando em andamento é distinto de resultado desconhecido/interrompido. Sem evidência, o relatório informa que os testes não foram executados. A classificação de comandos de teste/verificação reutiliza o reconhecedor existente do Hive.

## Persistência e proteção das notas

A migração acrescenta `live_results`, `generated_summaries` e `mission_notes` ao mesmo banco do Hive. Eventos continuam na tabela original; não há cópia de histórico nem outra orquestração. Chaves estrangeiras vinculam relatórios às execuções e notas às missões. Uma nova execução da mesma missão compartilha as notas manuais.

O caminho que salva relatórios não recebe nem grava notas. Notas possuem revisão própria: uma janela com revisão antiga recebe conflito, preserva o rascunho e permite comparar a versão salva antes de uma substituição explícita. A Queen recebe somente um contexto factual limitado da execução atual durante o planejamento; notas não são enviadas ao modelo.

O editor salva após 600 ms sem digitação, serializa gravações e confirma “Salvo” somente depois da resposta do processo principal. Cada edição também mantém um rascunho local síncrono por missão. Fechar o painel/janela tenta concluir a gravação; em caso de falha ou encerramento, o rascunho é recuperado na próxima abertura. Falhas de leitura não habilitam um editor vazio que possa sobrescrever conteúdo salvo. Falhas de salvamento permanecem visíveis e podem ser repetidas pelo botão. O Markdown usa o renderizador existente, com títulos, listas, checklists e blocos de código.

Rascunhos simultâneos também têm slots de recuperação separados. Textos de outras sessões que ainda não correspondem ao conteúdo salvo ficam disponíveis para comparação na aba Minhas Notas. Uma confirmação de gravação atrasada não remove um rascunho mais recente.

## Limitação explícita desta entrega

A sumarização narrativa por modelo de IA **não está habilitada**. Esta entrega implementa a primeira etapa autorizada no pedido: agregação factual determinística, com atualizações rastreáveis e resumos persistidos. A interface identifica esse modo. Não há chamadas adicionais a provedores, disputa de slots de agentes ou consumo adicional de tokens para documentação. Erros da projeção não alteram o estado do scheduler nem impedem a Queen de planejar.

A linha do tempo mantém textos antigos sem dados estruturados como “Não verificado”. Novos eventos de estado e merge do scheduler incluem os dados que permitem rastrear essas conclusões. A execução real dos testes continua sendo responsabilidade dos agentes; o Resultado Vivo observa a evidência existente.

## Validação automatizada

Os testes cobrem eventos reais do scheduler com worktree Git, projeção em segundo plano, conclusão da missão sem renderer, deduplicação, paginação, recuperação após reabrir o banco em arquivo, isolamento por missão, notas preservadas durante atualização automática, gravações concorrentes, rascunhos após falha/fechamento, reconexão e posições/dimensões manuais após atualizações. Testes de React exercitam o nó, o painel, Markdown e rajadas de histórico maiores que uma página.

A restauração de persistência é testada encerrando e reconstruindo o `DesktopService` completo e reabrindo o SQLite em arquivo, além de reconstruir isoladamente o serviço de projeção. O ciclo visual de encerrar e relançar o executável Electron não é automatizado por esses testes.

## Arquivos desta implementação

| Área                   | Arquivos novos ou alterados                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Contratos e evidências | `packages/core/src/live-result.ts`, `state.ts`, `state.test.ts`, `ipc.ts`, `index.ts`                                                |
| SQLite                 | `packages/persistence/src/database.ts`, `repositories.ts`                                                                            |
| Eventos do motor       | `packages/orchestrator/src/scheduler.ts`                                                                                             |
| Serviço principal      | `apps/desktop/src/main/live-result.ts`, `live-result.test.ts`, `service.ts`, `canvas-service.test.ts`                                |
| Nó e layout            | `apps/desktop/src/renderer/src/canvas/nodes.tsx`, `model.ts`, `model.test.ts`, `workspace.tsx`, `Inspector.tsx`, `canvas.css`        |
| Relatório e notas      | `apps/desktop/src/renderer/src/canvas/live-result-panel.tsx`, `use-live-result.ts`, `use-live-result.test.tsx`, `CanvasApp.test.tsx` |
| Markdown               | `apps/desktop/src/renderer/src/markdown.tsx`, `markdown.test.tsx`                                                                    |
| Documentação           | `RESULTADO-VIVO.md`                                                                                                                  |

As alterações locais que já existiam antes deste P0 foram preservadas; esta tabela descreve somente os arquivos tocados nesta implementação.
