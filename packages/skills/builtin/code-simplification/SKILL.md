---
name: code-simplification
description: 'Use quando o código funciona mas está mais difícil de ler, manter ou estender do que deveria, ou ao revisar código que acumulou complexidade: simplifica sem mudar em nada o comportamento.'
license: MIT
metadata:
  origin: Addy Osmani
  author: Addy Osmani
  source: https://github.com/addyosmani/agent-skills/tree/main/skills/code-simplification
  adapted: 'Traduzida para o português e adaptada às ferramentas do Hive'
---

# Simplificação de código

> Inspirada no plugin Code Simplifier do Claude Code e adaptada por Addy Osmani como uma skill de processo para qualquer agente de código.

Simplifique reduzindo a complexidade e mantendo **exatamente** o mesmo comportamento. O objetivo não é ter menos linhas: é código mais fácil de ler, entender, mudar e depurar. Toda simplificação precisa passar num teste simples: "uma pessoa nova na equipe entenderia isto mais rápido que o original?"

**No Hive:** se você é o revisor (só leitura), aponte as simplificações com arquivo, linha e a versão proposta; quem escreveu aplica. Se você pode editar, siga o processo abaixo.

## Quando usar

- A funcionalidade funciona e os testes passam, mas a implementação está mais pesada do que precisa.
- Na revisão, quando aparecem problemas de legibilidade ou complexidade.
- Diante de lógica muito aninhada, funções longas ou nomes confusos.
- Em código escrito com pressa.

**Quando NÃO usar:**

- O código já está limpo e legível: não simplifique por simplificar.
- Você ainda não entende o que o código faz: entenda antes.
- O código é crítico para desempenho e a versão "mais simples" seria mais lenta, de forma medida.
- O módulo vai ser reescrito inteiro.

## Os cinco princípios

### 1. Mantenha o comportamento exatamente igual

Mude só como o código se expressa, nunca o que ele faz. Entradas, saídas, efeitos, erros e casos de borda continuam idênticos. Na dúvida se uma simplificação mantém o comportamento, não faça.

```
ANTES DE CADA MUDANÇA, PERGUNTE:
→ Dá a mesma saída para toda entrada?
→ Mantém o mesmo comportamento de erro?
→ Mantém os mesmos efeitos, na mesma ordem?
→ Todos os testes continuam passando sem mexer neles?
```

### 2. Siga as convenções do projeto

Simplificar é deixar o código mais parecido com o resto do projeto, não impor preferência de fora. Antes, leia as regras do projeto e veja como o código vizinho resolve problemas parecidos: ordem dos imports, estilo de declarar funções, nomes, tratamento de erro, quantidade de anotação de tipos. Simplificação que quebra a consistência do projeto não é simplificação: é mexida à toa.

### 3. Clareza vence esperteza

Código explícito é melhor que código compacto quando o compacto exige uma pausa para decifrar.

```ts
// ❌ Ternários encadeados
const rotulo = isNovo ? 'Novo' : isAtualizado ? 'Atualizado' : isArquivado ? 'Arquivado' : 'Ativo';

// ✅ Legível
function rotuloDoStatus(item: Item): string {
  if (item.isNovo) return 'Novo';
  if (item.isAtualizado) return 'Atualizado';
  if (item.isArquivado) return 'Arquivado';
  return 'Ativo';
}
```

```ts
// ❌ reduce encadeado com lógica embutida
const resultado = itens.reduce(
  (acc, item) => ({
    ...acc,
    [item.id]: { ...acc[item.id], total: (acc[item.id]?.total ?? 0) + 1 },
  }),
  {},
);

// ✅ Passo intermediário com nome
const totalPorId = new Map<string, number>();
for (const item of itens) totalPorId.set(item.id, (totalPorId.get(item.id) ?? 0) + 1);
```

### 4. Equilíbrio

Também dá para simplificar demais. Cuidado com:

- **Embutir demais:** tirar uma função que dava nome a um conceito deixa a chamada mais difícil de ler.
- **Juntar lógicas diferentes:** duas funções simples viram uma complicada.
- **Tirar abstração "desnecessária"** que existe para testar ou estender.
- **Mirar no número de linhas:** a meta é entender mais rápido, não ter menos linhas.

### 5. Limite-se ao que mudou

Por padrão, simplifique o código mexido na tarefa. Nada de refatorar código sem relação, a menos que a tarefa peça.

## O processo

### 1. Entenda antes de mexer (a cerca de Chesterton)

Se você vê uma cerca no meio da estrada e não sabe por que ela está ali, não a derrube: descubra o motivo primeiro. Antes de simplificar, responda:

- Qual a responsabilidade deste código?
- Quem chama? O que ele chama?
- Quais são os casos de borda e os caminhos de erro?
- Há testes definindo o comportamento esperado?
- Por que ele pode ter sido escrito assim (desempenho, restrição de plataforma, histórico)?
- Consulte o Nectar (`nectar_search`): pode haver uma decisão registrada explicando.

Não sabe responder? Leia mais antes.

### 2. Procure as oportunidades

**Estrutura:**

| Padrão                             | Sinal                      | Simplificação                                       |
| ---------------------------------- | -------------------------- | --------------------------------------------------- |
| Aninhamento profundo (3+ níveis)   | Fluxo difícil de seguir    | Condições de saída antecipada ou funções auxiliares |
| Função longa (50+ linhas)          | Várias responsabilidades   | Dividir em funções focadas, com bons nomes          |
| Ternários aninhados                | Precisa de "pilha mental"  | `if`/`else`, `switch` ou objeto de consulta         |
| Parâmetros booleanos               | `fazer(true, false, true)` | Objeto de opções ou funções separadas               |
| A mesma condição em vários lugares | O mesmo `if` repetido      | Uma função com nome que diga a regra                |

**Nomes e legibilidade:**

| Padrão                 | Sinal                                           | Simplificação                                                   |
| ---------------------- | ----------------------------------------------- | --------------------------------------------------------------- |
| Nomes genéricos        | `dados`, `resultado`, `temp`, `item`            | Nome que diga o conteúdo: `perfilDoUsuario`, `errosDeValidacao` |
| Abreviações            | `usr`, `cfg`, `btn`                             | Palavra inteira, exceto as universais (`id`, `url`, `api`)      |
| Nome enganoso          | Função `buscar` que também altera estado        | Nome que diga o que ela faz                                     |
| Comentário do "o quê"  | `// soma 1` acima de `total++`                  | Apagar                                                          |
| Comentário do "porquê" | `// tenta de novo porque a API falha sob carga` | Manter                                                          |

**Redundância:**

| Padrão                       | Sinal                                                     | Simplificação                                |
| ---------------------------- | --------------------------------------------------------- | -------------------------------------------- |
| Lógica duplicada             | As mesmas 5+ linhas em vários lugares                     | Uma função compartilhada                     |
| Código morto                 | Ramos inalcançáveis, variáveis sem uso, blocos comentados | Remover (depois de confirmar que está morto) |
| Abstração que não agrega     | Invólucro que só repassa                                  | Chamar a função de baixo direto              |
| Padrão exagerado             | Fábrica de fábrica, estratégia com uma estratégia só      | A solução simples e direta                   |
| Conversão de tipo redundante | Converter para um tipo já inferido                        | Tirar                                        |

### 3. Uma mudança por vez

Faça uma simplificação, rode os testes com `run_command`. Passou: siga para a próxima. Falhou: desfaça e repense. Não junte várias simplificações sem testar no meio: se algo quebrar, você precisa saber qual foi. Refatoração vai separada de funcionalidade nova ou correção.

### 4. Confira o resultado

Compare antes e depois: ficou mesmo mais fácil de entender? Introduziu algum padrão diferente do projeto? A diferença está limpa e revisável? Se a versão "simplificada" ficou mais difícil, desfaça: nem toda tentativa dá certo.

## Exemplos rápidos (TypeScript)

```ts
// Invólucro async desnecessário
async function buscarUsuario(id: string) {
  return await usuarios.buscar(id);
} // antes
function buscarUsuario(id: string) {
  return usuarios.buscar(id);
} // depois

// Atribuição condicional verbosa
const nome = usuario.apelido || usuario.nomeCompleto;

// Montar lista na mão
const ativos = usuarios.filter((usuario) => usuario.isAtivo);

// Retorno booleano redundante
function isValido(texto: string) {
  return texto.length > 0 && texto.length < 100;
}

// Ifs aninhados → saídas antecipadas
function processar(dados?: Dados) {
  if (!dados) throw new TypeError('Sem dados');
  if (!dados.isValido()) throw new Error('Dados inválidos');
  if (!dados.temPermissao()) throw new Error('Sem permissão');
  return trabalhar(dados);
}
```

## Desculpas comuns

| Desculpa                                        | Realidade                                                               |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| "Está funcionando, não mexe."                   | Código difícil de ler vai ser difícil de consertar quando quebrar.      |
| "Menos linhas é sempre mais simples."           | Um ternário aninhado de 1 linha não é mais simples que um `if` de 5.    |
| "Já simplifico esse outro código aqui do lado." | Diferença barulhenta e risco de quebrar o que você não pretendia mudar. |
| "Essa abstração pode ser útil um dia."          | Não guarde abstração especulativa.                                      |
| "Refatoro enquanto faço a funcionalidade."      | São duas mudanças: separe.                                              |

## Sinais de alerta

- A simplificação exige mudar os testes para passar (provavelmente você mudou o comportamento).
- O código "simplificado" ficou maior e mais difícil de seguir.
- Renomear para o seu gosto, e não para a convenção do projeto.
- Tirar tratamento de erro porque "deixa o código mais limpo".
- Simplificar código que você não entende por completo.

## Antes de concluir

- [ ] Todos os testes passam sem terem sido alterados.
- [ ] O build passa sem avisos novos, e o lint também.
- [ ] Cada simplificação é uma mudança pequena e revisável.
- [ ] Nenhuma mudança sem relação misturada.
- [ ] O código segue as convenções do projeto.
- [ ] Nenhum tratamento de erro foi removido ou enfraquecido.
- [ ] Nenhum código morto ficou para trás.
