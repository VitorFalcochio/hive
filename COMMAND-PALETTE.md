# Command Palette do Nexus — P1

`Ctrl + Espaço` abre/fecha a paleta. `Esc` fecha e devolve o foco; as setas navegam e `Enter` executa. O botão de busca da toolbar também abre a paleta. O listener existe somente no renderer do Canvas: não há atalho global do Electron ou do sistema operacional.

Campos de texto, `contenteditable`, terminais xterm, Monaco/CodeMirror, comboboxes e componentes com `data-keyboard-owner` mantêm seus próprios atalhos. Eventos de composição IME, AltGraph, repetições e combinações com Alt/Meta não são interceptados. O sistema operacional continua podendo reservar Ctrl + Espaço.

## Comandos locais

- Nova missão, adicionar/configurar agente, nova tarefa, nota espacial e grupo.
- Abrir o Resultado Vivo existente e suas notas; o relatório continua sendo único por missão/execução.
- Centralizar, enquadrar, aproximar/afastar zoom, organizar e trocar entre Workspace, Agentes e Fluxo.
- Encontrar agentes, tarefas, notas, grupos, Resultado Vivo e missão por nome ou identificador; revelar nós ocultos quando necessário, centralizar e selecionar o elemento, abrindo o Inspector.
- Inspecionar missão, abrir logs/resultados e retomar quando o estado real do motor permite.
- Fixar posições e agrupar seleções compatíveis.

As ações locais usam os formulários e serviços atuais; continuam disponíveis sem IA. Operações indisponíveis ficam desabilitadas com uma explicação. Não existe comando fictício de pausa. Falhas ao carregar o layout mantêm a edição bloqueada até a recuperação, com botão de nova tentativa, para evitar gravar um layout vazio sobre posições persistidas.

Novas notas e grupos usam `screenToFlowPosition` para o centro da área visível e descontam o tamanho do nó. As notas foram verificadas sob zoom em navegador real. Novos agentes abrem no Workspace. Em Agentes, tarefas mantêm o posicionamento relativo ao grupo pai; em Workspace/Fluxo, tarefas criadas pela paleta recebem a posição central. Layout, tamanhos, posições fixadas e persistência continuam no mecanismo existente. O Hive ainda não oferece undo geral; a paleta não inventa esse recurso.

## Registry

`CommandRegistry<C>` independe do React e registra metadados, disponibilidade contextual e execução. A paleta só pesquisa, apresenta e despacha esses comandos. A busca normaliza acentos e caixa, indexa títulos/descrições/palavras-chave uma vez por registro e limita os resultados apresentados. Sem pesquisa, mostra as ações; as buscas de agentes/tarefas listam os elementos reais do Canvas selecionado.

## Queen Command Mode

“Pedir à Queen”, “Explicar missão”, “Resumir progresso” e “Sugerir próximas tarefas” usam a Queen e o cliente/provedor configurados no Hive. Uma instrução livre oferece a mesma consulta explicitamente; digitar na pesquisa não chama o modelo.

O processo principal monta o contexto da missão atual com seleção, tarefas, IDs de nós e um resumo factual limitado. **Minhas Notas não são enviadas ao modelo.** Usa a mesma fila do provedor, até 4.000 tokens de saída, uma consulta simultânea por missão, timeout de 60 segundos e verificação do orçamento diário. O uso retornado pelo provedor é persistido no histórico de consumo.

A resposta precisa obedecer a um schema Zod fechado. Operações permitidas: criar nota espacial/grupo/agente/tarefa, alterar visualização, encontrar um nó, organizar preservando posições fixadas, abrir relatório/logs e inspecionar missão. Explicação e progresso não podem propor alterações. Não há shell, eval, edição de arquivos, exclusão, deploy, alteração de notas pessoais ou operações desconhecidas.

O servidor guarda a proposta por até dez minutos. A aprovação envia apenas seu ID e a execução, nunca uma lista de ações fornecida pelo renderer. Antes de aplicar, valida novamente o plano, a missão, dependências, executores, limites e a versão estrutural do Canvas/layout. Uma mudança manual posterior à prévia exige uma nova proposta. A proposta é consumida antes da execução para impedir duplicação. Cancelar a consulta ou prévia não altera a missão.

Toda alteração passa pelos serviços reais existentes. Há prévia completa e aprovação explícita, inclusive para mudanças visuais propostas pela IA. Tarefas adicionadas a uma missão em execução podem começar imediatamente após aprovação; a prévia informa isso. Operações já concluídas são reportadas se uma etapa posterior falhar; o lote não é uma transação única entre scheduler e layout, e não é repetido automaticamente.

## Limitações

- Novos agentes criados pela Queen são reais, mas nascem sem provedor/modelo. Isso aparece na prévia; a configuração posterior usa o fluxo existente. Tarefas nesta mesma proposta só podem usar executores já configurados ou a seleção automática do Hive.
- Não há pausa real, undo geral ou execução de código retornado pela IA.
- As prévias são temporárias e expiram; não são restauradas após reiniciar o Hive. Os elementos aprovados usam a persistência normal.
- A integração de IA foi validada com respostas controladas de `ChatClient`; não foi feito um teste pago contra um provedor externo nesta entrega.

## Validação

Testes automatizados cobrem teclado/foco, proteção de editores/IME, registry extensível, busca sem acentos, criação persistente, seleção de agente, formulário de tarefa, aprovação explícita, rejeição de operações arbitrárias, isolamento por missão, modelo offline, limites de tokens, timeout/cancelamento, expiração, Canvas alterado após prévia e aplicação parcial sem duplicar agentes. O Resultado Vivo e as notas permanecem cobertos pela suíte existente.

Também foram verificadas janelas Electron reais ocultas, com perfil de teste separado e o preload compilado, em desenvolvimento e com `loadFile` do build de produção. Ambas confirmaram layout, nós, foco automático, abertura/fechamento e canal Queen no IPC, sem iniciar/cancelar a missão de teste. As capturas estão em `output/playwright/command-palette-electron-dev.png` e `command-palette-electron-production.png`. O navegador real também confirmou busca de agente, proteção do editor e criação centralizada sob zoom. Os serviços IPC desses testes visuais usam uma missão controlada; as mutações reais são testadas separadamente no `DesktopService`.

## Arquivos novos e alterados

| Área               | Arquivos                                                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contratos          | `packages/core/src/canvas-commands.ts` (novo), `ipc.ts`, `index.ts`                                                                                            |
| Scheduler          | `packages/orchestrator/src/index.ts` (exportação do limite existente)                                                                                          |
| Processo principal | `apps/desktop/src/main/canvas-queen.ts` e `canvas-queen.test.ts` (novos), `service.ts`                                                                         |
| Registry e UI      | `apps/desktop/src/renderer/src/canvas/command-registry.ts`, `command-palette.tsx`, `command-palette.test.tsx`, `queen-command.tsx` (novos)                     |
| Integração         | `apps/desktop/src/renderer/src/canvas/CanvasApp.tsx`, `CanvasApp.test.tsx`, `workspace.tsx`, `forms.tsx`, `use-layout.ts`, `use-layout.test.tsx`, `canvas.css` |
| Regressão de CSS   | `apps/desktop/src/renderer/src/canvas/styles.test.ts` (desativa watcher e pré-carregamento no servidor de teste)                                               |
| Documentação       | `COMMAND-PALETTE.md`                                                                                                                                           |
