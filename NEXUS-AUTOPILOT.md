# Nexus Autopilot

O Nexus Autopilot transforma uma instrução em linguagem natural em um plano visual, revisável e executável. Ele é uma camada de planejamento: a Queen gera somente dados validados; agentes, tarefas, dependências e início da missão continuam passando pelos serviços e pelo `Scheduler` existentes.

## Fluxo implementado

1. Abra pelo botão **Autopilot** na toolbar ou por `Ctrl + Espaço` → **Nexus Autopilot — Criar fluxo com IA**.
2. Informe o objetivo e escolha se a Queen pode reutilizar agentes configurados e sugerir novos agentes.
3. A Queen recebe contexto seletivo da missão: projeto, execução, agentes, modelos conhecidos, ferramentas, tarefas, worktrees alocadas, concorrência, aprovações e fatos do Resultado Vivo. O repositório e as notas privadas não são enviados indiscriminadamente.
4. A resposta precisa obedecer ao schema estrito de agentes, tarefas, dependências, critérios, aprovações e avisos. Código, shell e operações arbitrárias são rejeitados.
5. A prévia mostra o DAG, delegações, dependências e o Resultado Vivo sem criar ou executar nada.
6. O usuário pode editar objetivo, tarefas, critérios, dependências e delegações. Cada edição salva uma nova versão, preservando o histórico anterior.
7. **Aplicar fluxo** cria agentes e tarefas reais, mas mantém a missão parada. **Aplicar e iniciar** aplica o mesmo plano aprovado e chama `run.start` somente depois que todo o fluxo foi criado.
8. Reabrir o Autopilot recupera a versão mais recente. Uma aplicação repetida do mesmo plano retorna o recibo salvo sem duplicar tarefas.

O Resultado Vivo já é singleton por missão e recebe eventos reais de todas as tarefas. Por isso `connectResult` é obrigatório e o Autopilot não cria um segundo bloco de resultado.

## Segurança e validação

- IDs, chaves, limites e campos passam por Zod no renderer/main boundary e novamente no serviço.
- Dependências desconhecidas, autorreferências e ciclos são rejeitados.
- Tarefas respeitam o limite real do motor e só usam agentes executores configurados.
- Novos agentes só podem usar provedores habilitados e pares de modelo já conhecidos pelo Hive.
- A proposta fica vinculada a um fingerprint da execução. Mudanças posteriores exigem regeneração.
- Missões em execução podem receber uma prévia, mas a aplicação é bloqueada até a execução terminar ou ser cancelada pelo usuário. O Autopilot não cancela agentes silenciosamente.
- Falhas parciais ficam registradas e a versão passa a `failed`; uma repetição não recria silenciosamente as operações.
- O orçamento diário existente também limita o planejamento da Queen.

## Persistência

A migration `nexus_autopilot_plans` guarda ID, execução, versão, estado e o documento validado. Versões apontam para sua base por `basedOnPlanId`; propostas substituídas permanecem consultáveis. O recibo aplicado contém o mapa de agentes e tarefas efetivamente criados.

Estados persistidos: `proposed`, `superseded`, `applied`, `started`, `cancelled` e `failed`.

A migration `nexus_autopilot_recoveries` guarda cada replanejamento adaptativo: a tarefa que falhou, a cadeia (`rootTaskKey`), o erro e sua assinatura, as tarefas em espera, o patch proposto e o recibo do que foi criado.

## Replanejamento adaptativo (Autopilot 2.0)

Quando uma tarefa falha de vez durante a execução (depois das tentativas automáticas do Modo Turno, se houver), o Hive não cancela mais as tarefas que dependem dela. O ramo fica em espera e a Queen propõe outro caminho:

1. **Detecção:** o `Scheduler` avisa o Autopilot (`onTaskFailed`) antes de olhar os dependentes. O Autopilot registra a recuperação de forma síncrona e, a partir daí, `holds` mantém o ramo segurado.
2. **Isolamento:** só o ramo afetado para. As tarefas independentes seguem rodando e a missão continua `running` enquanto houver decisão pendente, mesmo quando a tarefa que falhou não tem dependentes.
3. **Patch, não plano novo:** a Queen recebe a falha real, o erro, o que já foi concluído e os replanejamentos anteriores. Ela devolve uma das estratégias: `replace` (refazer de outro jeito), `split` (dividir em passos menores), `reassign` (outro agente ou modelo) ou `skip` (seguir sem a tarefa). O patch só **adiciona** tarefas (e agentes para elas). Tarefas novas não podem depender da que falhou nem do que espera por ela.
4. **Aprovação:** o painel **Replanejamento** aparece no Nexus com o diagnóstico, as tarefas novas e quem passa a esperar o quê. Nada muda antes do clique em **Aprovar e continuar**. Ao aprovar, as tarefas são criadas pelo motor real, a que falhou vira "Descartada" e as dependentes passam a esperar as tarefas de `resumeFrom` (`Scheduler.reroute`).
5. **Outras saídas:** **Outra sugestão** consulta a Queen de novo. **Encerrar ramo** solta o ramo e os dependentes são cancelados, como antes. **Repetir tarefa** usa o retry normal.

### Limites contra ciclos

| Limite                                                                                       | Padrão       | Onde                                      |
| -------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------- |
| Replanejamentos aprovados por tarefa original (a substituta que falha conta na mesma cadeia) | 2 (1–3)      | Configurações → Replanejamento adaptativo |
| Sugestões da Queen por missão, aprovadas ou não                                              | 5 (1–10)     | Configurações → Replanejamento adaptativo |
| O mesmo erro (números, ids e caminhos ignorados) volta depois de um replanejamento           | para na hora | `failureSignature`                        |
| Orçamento diário de tokens                                                                   | o do Hive    | Configurações                             |

Quando um limite estoura, a Queen não é consultada: o registro fica como **Precisa de você** e o ramo continua segurado até o usuário repetir a tarefa ou encerrar o ramo. Tudo fica persistido em `nexus_autopilot_recoveries` e aparece no log da missão.

O recurso pode ser desligado nas Configurações. Desligado, uma falha cancela os dependentes na hora, como antes.

## Recuperação manual

Uma versão aplicada também oferece **Sugerir replanejamento** quando a execução terminou com falhas. O pedido inclui apenas as falhas reais registradas e gera uma nova prévia independente, que exige nova aprovação.

## Limitações atuais

- A edição híbrida cobre planos ainda não aplicados. Alterar ou remover retroativamente tarefas já iniciadas permanece sob as restrições do motor.
- O replanejamento adaptativo reage a falhas definitivas. Tarefa travada sem progresso e critério de aceitação não atendido ainda não disparam replanejamento (fase 2).
- No Modo Turno, um ramo em espera aguarda a decisão do usuário e segura a missão na fila. A aprovação automática de patches seguros fica para a fase 3.
- Se o app fechar com um ramo em espera, a execução é marcada como interrompida, como qualquer outra. Ao retomar, a tarefa que falhou é repetida normalmente.
- O consumo do planejamento é exibido quando o provedor informa tokens. A execução não recebe estimativa financeira quando o catálogo não oferece dados confiáveis.
- Uma falha no meio de um lote pode deixar operações reais já concluídas; o recibo persistido informa o progresso e o plano não é repetido automaticamente.
- O Autopilot adiciona fluxos à missão atual. Remoção destrutiva de agentes, tarefas ou worktrees não faz parte do schema permitido.

## Arquivos principais

- `packages/core/src/nexus-autopilot.ts`: schemas e contratos.
- `packages/persistence/src/database.ts` e `repositories.ts`: migration e repositório versionado.
- `apps/desktop/src/main/nexus-autopilot.ts`: contexto seletivo, Queen, validação e aplicação real.
- `apps/desktop/src/renderer/src/canvas/nexus-autopilot.tsx`: entrada, prévia, edição, aprovação e recuperação manual.
- `apps/desktop/src/renderer/src/canvas/recovery-panel.tsx`: painel do replanejamento adaptativo no Nexus.
- `packages/orchestrator/src/scheduler.ts`: `onTaskFailed`, `holds`, `reroute` e `refresh` do replanejamento.
- `apps/desktop/src/renderer/src/canvas/command-registry.ts`: comando da paleta existente.
- `apps/desktop/src/renderer/src/canvas/CanvasApp.tsx`: botão da toolbar.
- `apps/desktop/src/main/nexus-autopilot-recovery.test.ts` e `apps/desktop/src/renderer/src/canvas/recovery-panel.test.tsx`: replanejamento adaptativo.
- `apps/desktop/src/main/nexus-autopilot.test.ts` e `apps/desktop/src/renderer/src/canvas/nexus-autopilot.test.tsx`: testes do serviço e do fluxo visual.
