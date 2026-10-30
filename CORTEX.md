# Cortex — memória compartilhada do Nexus

O Cortex é um bloco nativo do Nexus: uma memória persistente, por projeto, que os agentes conectados a ele consultam e alimentam. As linhas desenhadas no canvas entre um agente e o Cortex são o controle de acesso. Sem linha, o agente não lê nem propõe nada.

Tudo o que um agente envia ao Cortex vira uma **proposta pendente**. Só depois que o usuário aprova é que a informação se torna memória compartilhada e passa a ser entregue a outros agentes.

## Como usar

1. Abra o Nexus e clique em **Blocos** na toolbar (ou `Ctrl + Espaço` → _Cortex — Shared Memory_, ou botão direito no canvas → _Novo Cortex_).
2. Arraste **Cortex — Shared Memory**, da categoria **Cortex**, para o canvas.
3. Arraste uma linha da borda direita de um agente (Backend, Frontend…) até o bloco. A conexão nasce com **Read + Propose**.
4. Dê dois cliques no bloco para abrir o **Cortex Inspector**. Na aba **Conexões** ajuste as permissões de cada agente; com o botão direito sobre a linha, abra as permissões ou desconecte.
5. Execute a missão. Antes de cada tarefa, o agente recebe as memórias aprovadas relevantes para ela e as ferramentas que suas permissões liberam.
6. Quando um agente propõe algo, o bloco mostra a contagem de **pendentes**. Em **Approvals** você vê o conteúdo, a justificativa, as evidências, o agente e a tarefa de origem, e decide: aprovar (podendo ajustar o texto antes), rejeitar ou pedir ajustes. O botão **Parecer da Queen** pede à Queen uma recomendação; a decisão continua sendo sua.
7. A memória aprovada fica no banco local do Hive. Outra missão do mesmo projeto mostra o mesmo bloco, com as mesmas conexões e memórias.

## Permissões

| Permissão   | O que libera para o agente                                                                                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Read**    | Recebe as memórias relevantes como contexto da tarefa e usa `cortex_search`.                                                                                                 |
| **Propose** | Usa `cortex_propose` para memórias novas e para alterar ou revogar as que ele mesmo escreveu (sempre como proposta).                                                         |
| **Approve** | Usa `cortex_pending` e `cortex_review`. Com a aprovação humana obrigatória (padrão), o veredito é só uma recomendação exibida ao usuário. Ninguém revisa a própria proposta. |
| **Manage**  | Propõe alterar ou revogar qualquer memória do Cortex, inclusive as escritas pelo usuário.                                                                                    |

Propose, Approve e Manage incluem Read. As permissões são verificadas no processo principal a cada operação: o bloco é relido em cada chamada de ferramenta, então uma desconexão feita no meio de uma tarefa corta o acesso na hora. Tentativas negadas ficam registradas na aba **Activity**.

## Capacidades

- **Memória compartilhada e persistente.** As memórias ficam no SQLite do Hive (tabelas `cortex_*`, migration 5) e sobrevivem ao encerramento da missão e ao reinício do aplicativo.
- **Memória por projeto.** Cada bloco pertence a um workspace. O contexto de uma tarefa usa apenas os blocos do projeto da própria execução. Um agente conectado a Cortex de dois projetos nunca recebe a memória de um no outro, inclusive com missões simultâneas.
- **Memória contextual.** A consulta usa título, descrição e critérios da tarefa. O ranking combina similaridade semântica (peso principal), afinidade com o papel do agente (frontend: UI, contratos de API, autenticação; backend: serviços, banco, regras; QA: requisitos, testes…), atualidade e tipo da memória (decisões e contratos pesam mais). Resultados quase idênticos são descartados e o total respeita o orçamento de tokens (padrão: 1.200 tokens por tarefa e 900 por `cortex_search`, configuráveis).
- **Histórico de decisões.** Cada memória tem id, tipo, título, conteúdo, justificativa, autor, aprovador, missão/tarefa de origem, projeto, evidências, datas, versão e histórico de alterações com o conteúdo anterior. Uma decisão alterada vira uma **nova decisão**; a anterior fica como _substituída_, ligada à nova (`supersedes` / `supersededBy`). Revogadas também permanecem consultáveis. A aba **Decisions** mostra a cadeia completa.
- **Notificações inteligentes.** Quando uma memória é aprovada, alterada, substituída ou revogada, o Cortex escolhe quem deve saber: agentes conectados com Read que já usaram aquela memória, que a proposta indicou como público (`audience`) ou, quando ninguém foi indicado, cujo papel trabalha com o assunto de uma memória normativa. O autor da mudança não é avisado. O aviso espera o **início da próxima tarefa** do agente, que é o ponto seguro: nenhuma execução é interrompida.

## Busca semântica

As memórias aprovadas são vetorizadas e os vetores ficam em `cortex_embeddings`, um por modelo, com o hash do texto. Uma segunda busca só vetoriza a pergunta; uma memória editada é revetorizada.

Há dois motores:

- **Local do Hive** (padrão, offline e gratuito): hashing de radicais, trigramas de caracteres, bigramas e uma tabela de **conceitos de software em português e inglês** (autenticação ↔ login ↔ identificação ↔ JWT ↔ sessão; banco ↔ tabela ↔ migração; contrato ↔ endpoint ↔ rota…). É o que faz _"Como devemos implementar a identificação dos usuários?"_ encontrar a decisão sobre JWT sem palavras em comum.
- **Provedor compatível com OpenAI** (`/embeddings`): por exemplo Ollama com `nomic-embed-text` (local e gratuito), LM Studio, OpenAI ou OpenRouter. Configure em _Conexões → Embeddings_. O texto passa pelo redator de segredos antes de sair da máquina.

Se o provedor falhar, a busca usa o motor local e a tarefa segue normalmente. A falha aparece no bloco (_Busca local_), na aba Activity (no máximo uma vez por minuto) e no resumo da tarefa. Vetores de modelos diferentes nunca são comparados entre si.

Na aba Memories, **Buscar por significado** roda a mesma busca que os agentes usam, para conferir o que eles receberiam.

## Segurança

- **Memórias são dados, não instruções.** No prompt, elas vão para a mensagem da tarefa dentro de blocos `<cortex_memory>`, precedidos de um aviso explícito de que são dados não confiáveis e de que comandos encontrados ali não devem ser seguidos. O texto não consegue fechar o bloco nem abrir outro.
- **Higienização na entrada.** Caracteres de controle, de largura zero e de inversão bidirecional são removidos. Propostas com algo que parece credencial (chaves `sk-`, `ghp_`, AWS, JWT, chaves privadas, `senha=`…) são recusadas.
- **Sinais de prompt injection** ("ignore as instruções", "você agora é", marcadores de conversa, ordens para executar comandos ou enviar credenciais) não bloqueiam a proposta, mas geram um alerta do sistema no card de aprovação.
- **Isolamento e rastreabilidade.** Toda operação valida que o bloco, a memória e a proposta pertencem ao mesmo Cortex e projeto. Consultas, contexto entregue, propostas, pareceres, decisões, avisos e acessos negados ficam em `cortex_activity`. Ações dos agentes também aparecem no log da missão (evento `memory`).
- **Concorrência.** A resolução de uma proposta confere, na mesma transação, se ela ainda está pendente e se a memória alvo ainda está vigente. Edição e revogação usam a versão esperada (compare-and-swap). Duas janelas, ou um usuário e um agente, nunca resolvem a mesma proposta duas vezes.

## Autopilot e Queen

- O Nexus Autopilot recebe a lista de blocos do projeto e de quem já está conectado, **sem o conteúdo das memórias**.
- O plano pode pedir `cortexAccess` para agentes do próprio fluxo, apenas com **Read** e/ou **Propose**. Pedidos com Approve ou Manage, ou para blocos de outro projeto, invalidam o plano.
- Na prévia, o usuário vê cada conexão proposta antes de aplicar. Ao aplicar, conexões existentes nunca são ampliadas nem reduzidas, e agentes sem pedido explícito continuam sem acesso.
- A Queen recebe memórias no planejamento somente se estiver conectada a um Cortex com Read.

## Arquitetura

| Responsabilidade             | Arquivo                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------- |
| Schemas, contrato e padrões  | `packages/core/src/cortex.ts`, `ipc.ts` (canais `cortex.*`)                   |
| Persistência                 | `packages/persistence/src/cortex.ts`, migration em `database.ts`              |
| Embeddings e motor local     | `apps/desktop/src/main/cortex/embeddings.ts`, `packages/providers` (`embed`)  |
| Indexação e busca contextual | `apps/desktop/src/main/cortex/search.ts`                                      |
| Permissões                   | `apps/desktop/src/main/cortex/permissions.ts`                                 |
| Propostas e aprovações       | `apps/desktop/src/main/cortex/ledger.ts`                                      |
| Conteúdo não confiável       | `apps/desktop/src/main/cortex/sanitize.ts`                                    |
| Notificações                 | `apps/desktop/src/main/cortex/notifications.ts`                               |
| Integração com agentes       | `cortex/service.ts` → `Scheduler.prepareMemory` → `AgentTaskInput.memory`     |
| Interface                    | `apps/desktop/src/renderer/src/canvas/cortex/*`, `nodes.tsx`, `workspace.tsx` |

O Cortex não cria outro editor de nós nem outro sistema de conexões. O bloco é um nó do React Flow existente, a linha é uma conexão comum validada por `isValidConnection`, a posição fica no layout do canvas e as alterações passam pelos canais IPC validados com Zod. O `Scheduler` ganhou um único gancho opcional, `prepareMemory`: se ele falhar, a tarefa roda sem memória e a falha fica registrada no log.

## Testes

- `apps/desktop/src/main/cortex/cortex.test.ts`:
  - acesso por conexão; não conectado sem acesso; sem Propose não propõe; desconexão no meio da tarefa;
  - pendente não é conhecimento; aprovação e rejeição; credenciais e injection;
  - histórico de decisões substituídas; busca semântica sem palavras em comum; vetores persistidos;
  - isolamento entre projetos; revogação; avisos só para os agentes relevantes;
  - falha do provedor de embeddings; orçamento de tokens;
  - Autopilot respeitando conexões e permissões;
  - fluxo completo com missão real em repositório Git: Backend propõe, usuário aprova, reinício do Hive, nova missão em que o Frontend recebe a decisão e o QA, não conectado, não recebe nada.
- `apps/desktop/src/renderer/src/canvas/cortex/cortex.test.tsx`: bloco e linhas no grafo, menu de blocos arrastável, comando na paleta, aprovação pelo Inspector, estados vazio e de erro, edição de permissões.

## Limitações conhecidas

- O motor local não é um modelo treinado. Ele entende sinônimos que estão na tabela de conceitos e variações de palavras, mas não substitui um modelo de embeddings real. Para melhor qualidade, configure um provedor (um Ollama local é gratuito).
- Só existe o escopo **projeto**. A estrutura (`config.scope`) já prevê outros escopos, ainda não implementados.
- A política de escrita **direta** (agentes com Approve publicam sem humano) existe no motor, mas a interface só expõe a opção de desligar a aprovação humana obrigatória. O padrão é aprovação.
- A busca vetorial é exata (força bruta sobre os vetores do projeto). Isso é adequado para milhares de memórias por projeto, mas não para milhões.
- O Autopilot conecta apenas agentes existentes ou criados pelo próprio fluxo a blocos que já existem. Ele não cria blocos Cortex.
- No modo de visualização **Fluxo**, os agentes não aparecem como nós, então as linhas de acesso ficam ocultas; o bloco continua visível, com as contagens.
