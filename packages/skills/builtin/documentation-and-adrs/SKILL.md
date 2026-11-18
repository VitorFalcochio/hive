---
name: documentation-and-adrs
description: 'Use ao tomar uma decisão de arquitetura (ADR), escolher entre abordagens, mudar uma API pública, entregar algo que muda o comportamento para o usuário ou quando a documentação pode estar desatualizada: registra o porquê, não só o quê.'
license: MIT
metadata:
  origin: Addy Osmani
  author: Addy Osmani
  source: https://github.com/addyosmani/agent-skills/tree/main/skills/documentation-and-adrs
  adapted: 'Traduzida para o português e adaptada às ferramentas do Hive'
---

# Documentação e registros de decisão (ADRs)

Documente decisões, não só código. A documentação mais valiosa guarda o **porquê**: o contexto, as restrições e as trocas que levaram a uma decisão. O código mostra _o que_ foi feito; a documentação explica _por que foi feito assim_ e _que alternativas foram consideradas_. Esse contexto é essencial para as pessoas e os agentes que vêm depois.

**Quando NÃO usar:** não documente código óbvio, não escreva comentários que repetem o que o código já diz, não escreva documentação para protótipo descartável.

## Registros de decisão (ADRs)

### Quando escrever um ADR

- Escolha de framework, biblioteca ou dependência importante.
- Modelo de dados ou esquema do banco.
- Estratégia de autenticação.
- Arquitetura da API (REST, GraphQL, tRPC).
- Ferramenta de build, hospedagem, infraestrutura.
- Qualquer decisão cara de desfazer.

**No Hive:** toda decisão desse tipo também vai para o Nectar com `nectar_propose` (tipo "Decisão"), curta e com o motivo. O ADR no repositório guarda o raciocínio completo; o Nectar faz os outros agentes saberem da decisão já na próxima tarefa.

### Siga a convenção que já existe

Antes de criar um ADR, veja se o projeto já tem um padrão: ADRs existentes, instruções do projeto, um arquivo `.adr-dir`. Se tiver, siga o local, o formato, a numeração e os títulos das seções. Só sem padrão nenhum use o modelo abaixo, em `docs/decisions/`.

### Modelo

```markdown
# ADR-001: Usar PostgreSQL como banco principal

## Situação

Proposta | Aceita | Substituída pelo ADR-XXX | Descontinuada

## Data

2025-01-15

## Contexto

Precisamos de um banco para o app de tarefas. Requisitos:

- Dados relacionais (usuários, tarefas, equipes)
- Transações para mudanças de estado das tarefas
- Busca de texto no conteúdo

## Decisão

PostgreSQL com o ORM Prisma.

## Alternativas consideradas

### MongoDB

- A favor: esquema flexível, fácil de começar.
- Contra: nossos dados são relacionais.
- Recusado: dado relacional num banco de documentos vira junções complicadas ou duplicação.

### SQLite

- A favor: zero configuração, rápido para leitura.
- Contra: escrita simultânea limitada.
- Recusado: não serve para app web com muitos usuários em produção.

## Consequências

- Acesso ao banco com tipos e migrações pelo Prisma.
- Busca de texto do próprio PostgreSQL, sem Elasticsearch.
```

### Ciclo de vida

```
PROPOSTA → ACEITA → (SUBSTITUÍDA ou DESCONTINUADA)
```

Não apague ADRs antigos: eles guardam o histórico. Quando uma decisão muda, escreva um ADR novo que cita e substitui o anterior.

## Comentários no código

Comente o **porquê**, não o **o quê**:

```ts
// ❌ Repete o código
// Soma 1 no contador
contador += 1;

// ✅ Explica a intenção que não é óbvia
// A janela do limite abre na primeira requisição depois que a anterior expira,
// não num horário fixo. Falha conhecida: dá para gastar o limite inteiro logo
// antes de zerar e de novo logo depois (o dobro num instante).
if (agora - inicioJanela > JANELA_MS) {
  contador = 0;
  inicioJanela = agora;
}
```

**Não faça:**

- Comentar código que se explica sozinho.
- Deixar `// TODO: tratar erro` para algo que você deveria fazer agora. Faça.
- Deixar código comentado. Apague: o git guarda o histórico.

**Documente as armadilhas conhecidas** onde elas importam: "IMPORTANTE: chame antes da primeira renderização, senão a tela pisca sem estilo. Veja o ADR-003."

## Documentação de API

Para APIs públicas, documente junto dos tipos:

```ts
/**
 * Cria uma tarefa.
 * @param entrada - título obrigatório, descrição opcional
 * @returns a tarefa criada, com id e datas gerados pelo servidor
 * @throws {ErroDeValidacao} se o título estiver vazio ou passar de 200 caracteres
 * @example
 * const tarefa = await criarTarefa({ titulo: 'Comprar pão' });
 */
```

Para APIs REST grandes, um arquivo OpenAPI ajuda quem consome.

## README

Todo projeto precisa de um README com:

- Uma frase sobre o que o projeto faz.
- **Começo rápido:** instalar dependências, configurar o ambiente, rodar.
- **Comandos:** tabela com `dev`, `test`, `build`, `lint`.
- **Arquitetura:** visão geral curta e link para os ADRs.

## Registro de mudanças (changelog)

Para o que foi entregue, acrescente no topo, com data e seções "Adicionado", "Corrigido", "Alterado". Nunca reescreva entradas antigas: o git guarda o texto velho, mas o changelog é o único registro dos motivos.

## Documentação para agentes

- **Arquivos de regras do projeto** (`AGENTS.md`, `CLAUDE.md`): convenções que os agentes devem seguir.
- **ADRs:** fazem os agentes entenderem por que uma decisão foi tomada, e evitam decidir tudo de novo.
- **O Nectar:** decisões e contratos aprovados chegam aos agentes conectados no início de cada tarefa.

## Documentação desatualizada

Um documento verdadeiro quando foi escrito continua parecendo verdadeiro depois que o código muda. Quando suspeitar, decida pelo histórico do git, não pelo tom do documento: compare o último commit do código com o último commit do documento. Se o código mudou depois, o documento provavelmente está velho. Se não dá para saber (ramos divergentes, rebase), diga "não dá para saber"; nunca diga que está atual.

## Desculpas comuns

| Desculpa                              | Realidade                                                                           |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| "O código se documenta sozinho."      | O código mostra o quê. Não mostra por quê, nem o que foi recusado.                  |
| "Documento quando a API estabilizar." | A API estabiliza mais rápido quando é documentada.                                  |
| "Ninguém lê documentação."            | Os agentes leem. Você mesmo, daqui a três meses, lê.                                |
| "ADR é burocracia."                   | Um ADR de 10 minutos evita 2 horas de discussão sobre a mesma decisão meses depois. |

## Antes de concluir

- [ ] Decisões importantes têm ADR (e foram propostas ao Nectar).
- [ ] O README explica como rodar, os comandos e a arquitetura.
- [ ] Funções públicas documentam parâmetros e retorno.
- [ ] Armadilhas conhecidas estão comentadas onde importam.
- [ ] Nenhum código comentado ficou para trás.
- [ ] O changelog recebeu entradas novas, sem reescrever as antigas.
