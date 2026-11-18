---
name: api-and-interface-design
description: 'Use ao desenhar APIs, rotas REST ou GraphQL, contratos de tipos entre módulos, props de componentes ou a fronteira entre frontend e backend: interfaces estáveis, previsíveis e difíceis de usar errado.'
license: MIT
metadata:
  origin: Addy Osmani
  author: Addy Osmani
  source: https://github.com/addyosmani/agent-skills/tree/main/skills/api-and-interface-design
  adapted: 'Traduzida para o português e adaptada às ferramentas do Hive'
---

# Design de APIs e interfaces

Desenhe interfaces estáveis, bem documentadas e difíceis de usar errado. Uma boa interface torna o certo fácil e o errado difícil. Vale para APIs REST, esquemas GraphQL, fronteiras entre módulos, props de componentes e qualquer lugar onde um código conversa com outro.

## Quando usar

- Rotas novas de API.
- Fronteiras entre módulos ou contratos entre agentes que trabalham em paralelo.
- Props de componentes.
- Esquema de banco que define o formato da API.
- Mudança numa interface pública existente.

## Princípios

### Lei de Hyrum

> Com usuários suficientes, todo comportamento observável do sistema vai ser usado por alguém, não importa o que o contrato promete.

Todo comportamento público (inclusive manias não documentadas, o texto das mensagens de erro, a ordem dos resultados) vira contrato quando alguém depende dele. Então:

- **Escolha com cuidado o que expor.** Cada comportamento observável é um compromisso.
- **Não vaze detalhes de implementação.** Se dá para ver, alguém vai depender.
- **Pense na remoção já no desenho.**

### Uma versão só

Evite obrigar quem usa a escolher entre várias versões da mesma API. Estenda em vez de bifurcar.

### 1. Contrato primeiro

Defina a interface antes de implementar. O contrato é a especificação; a implementação vem depois.

```ts
interface TarefasAPI {
  // Cria e devolve a tarefa com os campos gerados pelo servidor
  criar(entrada: CriarTarefa): Promise<Tarefa>;
  // Lista paginada, com filtros
  listar(params: ListarTarefas): Promise<Pagina<Tarefa>>;
  // Uma tarefa, ou erro NaoEncontrado
  buscar(id: string): Promise<Tarefa>;
  // Atualização parcial: só os campos enviados mudam
  atualizar(id: string, entrada: AtualizarTarefa): Promise<Tarefa>;
  // Apagar é idempotente: dá certo mesmo se já foi apagada
  apagar(id: string): Promise<void>;
}
```

**No Hive:** quando frontend e backend vão trabalhar em paralelo, defina o contrato antes e registre no Nectar com `nectar_propose` (tipo "Contrato de API"). Assim o outro agente usa os mesmos nomes e formatos.

### 2. Erros sempre do mesmo jeito

Escolha uma estratégia de erro e use em todo lugar:

```ts
interface ErroDaAPI {
  error: {
    code: string; // Para a máquina: "VALIDATION_ERROR"
    message: string; // Para a pessoa: "O e-mail é obrigatório"
    details?: unknown; // Contexto extra, quando ajuda
  };
}
// 400 dados inválidos · 401 não autenticado · 403 sem permissão
// 404 não encontrado · 409 conflito · 422 validação falhou
// 500 erro do servidor (nunca exponha detalhes internos)
```

Não misture: se umas rotas lançam erro, outras devolvem `null` e outras `{ error }`, ninguém consegue prever o comportamento.

### 3. Valide nas fronteiras

Confie no código interno. Valide onde a entrada de fora chega:

```ts
app.post('/api/tarefas', async (req, res) => {
  const resultado = CriarTarefaSchema.safeParse(req.body);
  if (!resultado.success)
    return res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Dados inválidos',
        details: resultado.error.flatten(),
      },
    });
  // Depois da validação, o código interno confia nos tipos
  return res.status(201).json(await tarefas.criar(resultado.data));
});
```

**Onde validar:** rotas da API, envio de formulários, respostas de serviços externos (sempre dado não confiável), leitura de variáveis de ambiente.

**Onde não precisa:** entre funções internas que compartilham tipos, em utilitários chamados por código já validado, em dados que acabaram de sair do seu próprio banco.

### 4. Prefira acrescentar a mudar

```ts
// ✅ Campos novos opcionais: quem já usa não quebra
interface CriarTarefa {
  titulo: string;
  descricao?: string;
  prioridade?: 'baixa' | 'media' | 'alta'; // acrescentado depois
}
// ❌ Remover campo ou mudar o tipo quebra quem já usa
```

### 5. Nomes previsíveis

| O quê               | Convenção                             | Exemplo                                 |
| ------------------- | ------------------------------------- | --------------------------------------- |
| Rotas REST          | Substantivo no plural, sem verbo      | `GET /api/tarefas`, `POST /api/tarefas` |
| Parâmetros e campos | camelCase                             | `?ordenarPor=criadoEm`, `{ criadoEm }`  |
| Booleanos           | Prefixo é/tem/pode (`is`/`has`/`can`) | `isConcluida`, `hasAnexos`              |
| Valores de enum     | MAIÚSCULAS_COM_SUBLINHADO             | `"EM_ANDAMENTO"`                        |

Siga a língua e o padrão que o projeto já usa. Se o código está em inglês, continue em inglês.

### 6. Repetição segura (chave de idempotência)

Em rotas que cobram, criam pedidos ou mudam estado, uma nova tentativa não pode duplicar o efeito:

- **A chave vem da intenção, não da tentativa:** o cliente gera uma vez e reusa ao tentar de novo, ou ela deriva de um identificador fixo (`cobranca:v1:${pedidoId}`). Nunca um UUID ou horário novo a cada tentativa.
- **Reserve a chave numa operação atômica**, com restrição de unicidade no banco. "Consultar e depois inserir" é corrida: duas tentativas simultâneas passam.
- **Mesma chave com corpo diferente** é erro do cliente: responda 422 em vez de repetir a primeira resposta.
- **Toda chamada tem três resultados:** sucesso, falha e _desconhecido_ (tempo esgotado). Registre a intenção antes de chamar o serviço externo.

## Padrões REST

```
GET    /api/tarefas                → lista (filtros na query)
POST   /api/tarefas                → cria
GET    /api/tarefas/:id            → uma
PATCH  /api/tarefas/:id            → atualiza parte
DELETE /api/tarefas/:id            → apaga
GET    /api/tarefas/:id/comentarios → sub-recurso
```

- **Paginação** em toda lista: `?pagina=1&tamanho=20`, e a resposta traz `{ dados, paginacao: { pagina, tamanho, total, totalPaginas } }`.
- **Filtros** na query: `?status=EM_ANDAMENTO&criadoDepois=2025-01-01`.
- **PATCH** aceita objeto parcial: só o que veio muda.

## Padrões em TypeScript

- **União discriminada para variantes:** `{ tipo: 'pendente' } | { tipo: 'concluida'; concluidaEm: Date }`. Quem usa ganha o estreitamento de tipo no `switch`.
- **Entrada separada da saída:** `CriarTarefa` (o que o cliente manda) é diferente de `Tarefa` (o que o sistema devolve, com `id`, `criadoEm`…).
- **IDs com marca de tipo** (`type TarefaId = string & { __marca: 'TarefaId' }`) evitam passar o ID de um usuário onde se espera o de uma tarefa.

## Desculpas comuns

| Desculpa                                          | Realidade                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| "Documento a API depois."                         | Os tipos SÃO a documentação. Defina primeiro.                            |
| "Por enquanto não precisa paginar."               | Vai precisar no dia em que alguém tiver 100 itens.                       |
| "Ninguém usa esse comportamento não documentado." | Lei de Hyrum: se dá para ver, alguém depende.                            |
| "API interna não precisa de contrato."            | Quem usa por dentro também usa. O contrato permite trabalho em paralelo. |

## Sinais de alerta

- Rotas que devolvem formatos diferentes conforme a situação.
- Formatos de erro diferentes entre rotas.
- Validação espalhada pelo código interno em vez de nas fronteiras.
- Mudança que quebra campos existentes.
- Lista sem paginação.
- Verbo na URL (`/api/criarTarefa`).
- Resposta de serviço externo usada sem validação.

## Antes de concluir

- [ ] Toda rota tem tipos de entrada e saída.
- [ ] Todos os erros seguem o mesmo formato.
- [ ] A validação fica nas fronteiras.
- [ ] Listas têm paginação.
- [ ] Campos novos são opcionais (compatível com quem já usa).
- [ ] Os nomes seguem a mesma convenção em todas as rotas.
- [ ] Os tipos ou a documentação estão junto da implementação, e o contrato foi registrado no Nectar quando outro agente depende dele.
- [ ] Rotas que mudam estado são seguras para repetir, ou estão documentadas como não seguras.
