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

## Recuperação controlada

Quando uma execução possui tarefas falhas, uma versão aplicada oferece **Sugerir replanejamento**. O pedido inclui apenas as falhas reais registradas e gera uma nova prévia independente. Não existem retries automáticos nem criação ilimitada de agentes: custo continua limitado pelo orçamento, a geração é explícita e toda aplicação exige nova aprovação.

## Limitações atuais

- A edição híbrida cobre planos ainda não aplicados. Alterar ou remover retroativamente tarefas já iniciadas permanece sob as restrições do motor.
- Recuperação é sugestiva e acionada pelo usuário; não há loop automático de replanejamento.
- O consumo do planejamento é exibido quando o provedor informa tokens. A execução não recebe estimativa financeira quando o catálogo não oferece dados confiáveis.
- Uma falha no meio de um lote pode deixar operações reais já concluídas; o recibo persistido informa o progresso e o plano não é repetido automaticamente.
- O Autopilot adiciona fluxos à missão atual. Remoção destrutiva de agentes, tarefas ou worktrees não faz parte do schema permitido.

## Arquivos principais

- `packages/core/src/nexus-autopilot.ts`: schemas e contratos.
- `packages/persistence/src/database.ts` e `repositories.ts`: migration e repositório versionado.
- `apps/desktop/src/main/nexus-autopilot.ts`: contexto seletivo, Queen, validação e aplicação real.
- `apps/desktop/src/renderer/src/canvas/nexus-autopilot.tsx`: entrada, prévia, edição, aprovação e recuperação.
- `apps/desktop/src/renderer/src/canvas/command-registry.ts`: comando da paleta existente.
- `apps/desktop/src/renderer/src/canvas/CanvasApp.tsx`: botão da toolbar.
- `apps/desktop/src/main/nexus-autopilot.test.ts` e `apps/desktop/src/renderer/src/canvas/nexus-autopilot.test.tsx`: testes do serviço e do fluxo visual.
