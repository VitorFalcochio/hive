# Hive Guardian

O Guardian monitora a própria colmeia: componentes, agentes, provedores, janelas e recursos. Ele abre incidentes quando algo dá errado e oferece recuperações. Roda no processo principal, a cada 30 segundos, **sem usar nenhum modelo de IA**.

Para abrir: menu lateral → **Guardian**.

## Decisões de arquitetura

1. **Reaproveitar a recuperação que já existe, não duplicá-la.** O Hive já retoma missões interrompidas com checkpoints, tenta de novo com espera crescente (`withRetries`), troca de provedor e deixa a rota que falhou "descansando" (`RouteHealth`, que funciona como circuit breaker). O Guardian não reimplementa nada disso: ele **mostra** o estado e oferece as ações que exigem uma pessoa.
2. **Escutar o log em vez de detectar de novo.** A janela já detectava congelamento e queda (`windows.ts`) e gravava tudo no log. O logger ganhou `onLog`, e o Guardian ouve essas linhas. No início, ele lê o fim do log anterior, porque um congelamento que fez o usuário reiniciar é justamente o que ele precisa ver.
3. **Checagens puras.** Cada checagem é uma função sem efeitos colaterais (`guardian/checks.ts`), testada isoladamente. Uma checagem que quebra vira um incidente e **não impede as outras**.
4. **Um incidente por problema.** Cada problema tem uma chave estável (`silent:<tarefa>`, `providers:resting`…). Enquanto ele durar, o incidente é atualizado em vez de duplicado. Quando a checagem passa de novo, ele é resolvido sozinho.
5. **Recuperação sempre por clique.** Nenhuma ação roda sozinha. As que removem ou param algo (`cancel-task`, `prune-worktrees`, `reload-windows`) pedem confirmação. Todas são idempotentes: repetir não faz nada a mais.
6. **Nada se perde.** Uma worktree órfã **com alterações não salvas nunca é apagada**, nem pela limpeza ao abrir o Hive (o que antes acontecia), nem pelo Guardian. Ela vira um incidente com o caminho, para o usuário decidir.

## O que é checado

| Componente | Como | Incidente |
|---|---|---|
| Banco de dados | tempo de uma leitura simples | lento (> 2 s) |
| Git e projetos | `gitPreflight` em até 8 projetos, priorizando os que têm missão ativa | Git ausente, pasta que não é repositório, repositório sem commit |
| Cópias dos agentes | worktrees na pasta do Hive sem tarefa dona | sobras limpas (limpar) e sobras com alterações (só avisa) |
| Agentes trabalhando | último evento de cada tarefa em andamento (sinal de vida) | sem progresso há 10 min (alerta) ou 25 min (crítico); a mesma ferramenta chamada 6 vezes seguidas (loop) |
| Tarefas | tarefas que falharam nas últimas 24 h | oferece repetir |
| Provedores | modelos descansando e erros de provedor nos últimos 15 min | descanso (liberar agora), rajada de erros |
| Interface | linhas do log da janela | janela sem responder, queda da interface |
| Processo principal | erros sem tratamento no log | erro nos últimos 10 min |
| Recursos | `app.getAppMetrics()`, memória livre, espaço em disco (`statfs`) | memória do sistema < 5%, Hive > 3 GB, disco < 2 GB |

Esperar a aprovação do usuário **não** conta como travamento.

## Recuperações

| Ação | O que faz | Confirmação |
|---|---|---|
| Repetir tarefa | uma tarefa que falhou volta para a fila | não |
| Cancelar tarefa | para uma tarefa sem progresso; o que ela salvou fica no branch | sim |
| Limpar cópias sobrando | remove worktrees órfãs **sem** alterações | sim |
| Liberar modelos agora | encerra o descanso de todas as rotas de provedor | não |
| Fazer backup agora | cópia do banco e das skills | não |
| Recarregar janelas | recarrega as telas; as missões seguem no processo principal | sim |

O histórico de recuperações e os incidentes ficam no banco (`guardian:recoveries` e `guardian:incidents`, com limites).

## Relatório

**Exportar relatório** salva um Markdown com componentes, agentes, recursos, incidentes, recuperações e o log recente. Antes de salvar, o texto passa por:

- remoção das chaves que o Hive conhece e de qualquer texto no **formato** de chave (OpenAI, Anthropic, OpenRouter, GitHub, Groq, Google, NVIDIA, Slack). Esse reforço foi feito no `secretRedactor` compartilhado, então protege também o log;
- troca da pasta pessoal por `~` e do nome da conta do sistema por `<usuário>`.

## Limitações reais

- **Sinal de vida = eventos.** Os agentes não mandam um "ping" próprio. Uma chamada de modelo muito longa e silenciosa (vários minutos) pode aparecer como "sem progresso" sem estar travada.
- **Reinício isolado só da interface.** O Guardian recarrega janelas e cancela ou repete tarefas, mas não reinicia processos isolados como terminais, servidores MCP ou o motor do Claude Code.
- **Dependências não são diagnosticadas** (por exemplo, `node_modules` faltando num projeto). Só o Git é checado.
- **Sem alertas fora do app.** Os incidentes não geram notificação do Windows. Isso seria fácil de ligar, mas pode virar ruído. Fica para decidir com uso real.
- **CPU por amostra.** O percentual vem do Electron no momento da checagem, não é uma média.
- O congelamento real da janela foi testado pela regra (linhas do log), não provocado no app.

## Arquivos

- `packages/core/src/guardian.ts`: tipos e ações (com validação zod).
- `apps/desktop/src/main/guardian/checks.ts`: checagens puras.
- `apps/desktop/src/main/guardian/guardian.ts`: ciclo, incidentes, recuperações e relatório.
- `apps/desktop/src/main/guardian/resources.ts`: métricas de processo, memória e disco.
- `apps/desktop/src/renderer/src/guardian.tsx`: página.
- `apps/desktop/src/main/logger.ts`: `onLog`.
- `packages/orchestrator/src/scheduler.ts`: `leftoverWorktrees` e `pruneWorktrees` (públicos, preservam alterações).
- `packages/providers/src/failover.ts`: `RouteHealth.clear`.
- `packages/shared/src/secrets.ts`: formatos de chave.
