# Hive Teams

O Hive Teams deixa um agente liderar uma tarefa grande: ele define a abordagem, cria membros para a equipe (em outros provedores também), delega, pede revisões e consolida o resultado. Tudo acontece na mesma missão, pelo mesmo motor do Hive: Scheduler, `NativeAgentRuntime`, worktrees, Nectar, QA e revisão continuam os de sempre.

Fica **desligado por padrão**. Ligue em **Configurações → Missões → Hive Teams**. Desligado, a Queen não sabe de líderes, nenhum agente recebe as ferramentas de equipe e as missões correm exatamente como antes.

## Como funciona

```
Queen ── plano ──► [Líder: tarefa "lead"]     define o contrato, cria membros e delega, e encerra
                       │ Hive Teams valida cada pedido e cria agentes e tarefas reais da missão
                       ├─► [Membro: implementar]
                       ├─► [Membro: revisar] ── submit_review ──► o trabalho volta ao autor (revisão)
                       └─► [Líder: consolidar]   retomado com os resultados; report_to_queen
                                 └─► [QA]  passa a esperar a consolidação
```

1. A Queen marca `"lead": true` na tarefa do líder (só com o Hive Teams ligado).
2. Na sessão do líder, as ferramentas `spawn_agent`, `delegate_task`, `request_review` e `report_to_queen` chegam pela mesma via do Nectar (`AgentMemory.tools`). O runtime não foi reescrito.
3. Cada pedido vai ao motor `HiveTeams` (`packages/orchestrator/src/teams`), que valida e cria agentes e tarefas pelo Scheduler.
4. O líder **não espera ativo**: chama `finish` depois de delegar. Uma tarefa de consolidação, do próprio líder, espera a equipe; ao começar, ele recebe os resultados e as mensagens.
5. O revisor chama `submit_review`. Com mudanças pedidas, a tarefa revisada volta ao autor pela revisão que já existia (`task.revise`), com os comentários por arquivo e linha.
6. O que dependia do líder (o QA, por exemplo) passa a depender da consolidação, e assim vê o resultado da equipe.
7. A entrega fica em revisão. Nada chega à branch do usuário sem aprovação, como em qualquer missão.

## Identidade, rastreio e idempotência

- **Agentes** criados pelo Hive Teams têm `team`: `runId`, `parentAgentId`, `createdByAgentId`, `spawnRequestId` e `depth`. A identidade fica separada das tarefas. A interface não consegue marcar um agente assim, e agentes de outra missão não aparecem nem no planejamento nem no canvas.
- **Tarefas** têm `parentTaskId` e `team` (`lead`, `member`, `review`, `consolidate`).
- **Mensagens** (`team_messages`) e **pedidos** (`team_requests`) ficam gravados. O id de cada um vem de uma chave de idempotência: pedir ou enviar de novo, depois de uma repetição ou de uma queda, devolve o que foi decidido da primeira vez. Um pedido interrompido no meio é completado, não duplicado.
- O que vem de outros agentes entra no prompt como **dado, não como instrução**.

## Limites e privilégios

- Um membro **nunca recebe mais que o líder**: ferramentas, comandos aprovados automaticamente, servidores MCP e limites (passos, tokens, tempo). Pedir mais é recusado com o motivo, não cortado em silêncio.
- **Globais e por equipe** (configuráveis): agentes por missão, membros por líder, profundidade (padrão 1: um membro não cria outros), delegações por líder, rodadas de revisão, retomadas do líder e orçamento de tokens da equipe. Continuam valendo o orçamento por missão e o diário.
- **Sem custo extra, por padrão.** Com a trava ligada (o padrão), membros só nascem em modelos gratuitos (`:free` ou preço zero), em camadas grátis (NVIDIA e outras, a mesma regra do roteador de modelos do Hive), num servidor local ou no plano do ChatGPT que o usuário já paga. Um modelo pago é recusado mesmo pedido pelo nome; um modelo de gateway sem preço publicado também. Só o usuário desliga a trava, nas Configurações.
- Membros usam só **provedores já configurados** no Hive. O Codex é procurado primeiro no login oficial do ChatGPT; o Nemotron, na NVIDIA e depois no OpenRouter.

## Claude Code

A integração atual (bloco Terminal com o Claude Code) continua como está. O Hive **não** reutiliza tokens OAuth nem usa a assinatura como API. Para uma integração programática permitida no futuro, o Scheduler tem um ponto de extensão: `runtimeFor(worker)` escolhe, por agente, outro motor que implemente `AgentRuntime` (`packages/agents/src/runtime.ts`). Sem ele, todo agente roda no `NativeAgentRuntime`. Hoje, o Claude pode liderar pelo OpenRouter.

## Testes

- `packages/orchestrator/src/teams/engine.test.ts`: regras de criação, privilégios, limites, delegação, consolidação, revisão e idempotência, inclusive um pedido interrompido no meio.
- `packages/orchestrator/src/teams/teams.flow.test.ts`: o cenário da API de tarefas, de ponta a ponta, com o runtime, o Scheduler e as worktrees reais e três provedores simulados; também cancelar e retomar, a queda do app e a falha de um membro. Roda no grupo **integração**, depois dos outros testes.
- `packages/persistence/src/teams.test.ts`: compatibilidade com dados antigos, migração e gravação única.
- Nenhum teste chama provedores reais.
