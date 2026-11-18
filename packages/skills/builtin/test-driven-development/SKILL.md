---
name: test-driven-development
description: 'Use ao implementar qualquer funcionalidade ou correção, antes de escrever o código: escreve o teste primeiro, vê ele falhar e só então escreve o mínimo para passar.'
license: MIT
metadata:
  origin: Superpowers
  author: Jesse Vincent
  source: https://github.com/obra/superpowers/tree/main/skills/test-driven-development
  adapted: 'Traduzida para o português e adaptada às ferramentas do Hive'
---

# Desenvolvimento guiado por testes (TDD)

Escreva o teste primeiro. Veja ele falhar. Escreva o mínimo de código para passar.

**Princípio:** se você não viu o teste falhar, não sabe se ele testa a coisa certa.

## Quando usar

**Sempre:** funcionalidade nova, correção de bug, refatoração, mudança de comportamento.

**Exceções:** protótipo descartável, código gerado, arquivo de configuração. Se a tarefa não pede teste e o projeto não tem como rodar testes, diga isso no `finish` em vez de fingir que testou.

Pensando "só desta vez pulo o TDD"? Pare. Isso é desculpa.

## A lei de ferro

```
NENHUM CÓDIGO DE PRODUÇÃO SEM UM TESTE FALHANDO ANTES
```

Escreveu código antes do teste? Apague e comece de novo, a partir do teste. Não guarde como "referência" nem "adapte" enquanto escreve o teste.

## Vermelho, verde, refatorar

### VERMELHO: escreva um teste que falha

Um teste mínimo mostrando o que deve acontecer.

```ts
// ✅ Bom: nome claro, testa o comportamento real, uma coisa só
test('tenta de novo as operações que falham, até 3 vezes', async () => {
  let tentativas = 0;
  const operacao = () => {
    tentativas++;
    if (tentativas < 3) throw new Error('falhou');
    return 'sucesso';
  };
  expect(await tentarDeNovo(operacao)).toBe('sucesso');
  expect(tentativas).toBe(3);
});

// ❌ Ruim: nome vago, testa o mock e não o código
test('retry funciona', async () => {
  const mock = vi.fn().mockRejectedValueOnce(new Error()).mockResolvedValueOnce('ok');
  await tentarDeNovo(mock);
  expect(mock).toHaveBeenCalledTimes(2);
});
```

Um comportamento, nome claro, código real (mock só quando não tem jeito).

### Confirme o VERMELHO: veja falhar

**OBRIGATÓRIO.** Rode o teste com `run_command` usando o comando de teste do projeto. Confirme:

- O teste **falha** (não dá erro de sintaxe ou de importação).
- A mensagem de falha é a esperada.
- Falha porque a funcionalidade falta, não por erro de digitação.

**Passou de primeira?** Você está testando algo que já existe. Corrija o teste.

### VERDE: o código mínimo

O código mais simples que faz o teste passar. Nada de opções, recursos extras ou "melhorias" além do teste.

### Confirme o VERDE: veja passar

**OBRIGATÓRIO.** Confirme que o teste passa, que os outros continuam passando e que a saída está limpa (sem erros nem avisos).

**"Os outros testes" são a suíte do projeto, não só o seu arquivo.** Antes de dar por concluído, rode o comando de teste do projeto inteiro (`npm test`, `pytest`, `cargo test`). Qualquer falha que aparecer, mesmo uma que você não causou, vai no seu relato pelo nome.

**Falhou?** Corrija o código, não o teste.

### REFATORAR

Só com tudo verde: tire duplicação, melhore nomes, extraia funções auxiliares. Continue verde e não acrescente comportamento.

### Repita

Próximo teste falhando para o próximo comportamento.

## Bons testes

| Qualidade         | Bom                                 | Ruim                                        |
| ----------------- | ----------------------------------- | ------------------------------------------- |
| Mínimo            | Uma coisa. Tem "e" no nome? Divida. | `test('valida e-mail e domínio e espaços')` |
| Claro             | O nome descreve o comportamento     | `test('teste1')`                            |
| Mostra a intenção | Demonstra a API desejada            | Esconde o que o código deve fazer           |

Ao escrever ou mudar qualquer teste, abra `writing-good-tests.md` com `read_skill_resource`: ele traz as regras que mantêm os testes honestos.

## Desculpas comuns

| Desculpa                                  | Realidade                                                               |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| "Simples demais para testar."             | Código simples também quebra. O teste leva 30 segundos.                 |
| "Testo depois."                           | Teste escrito depois passa na hora, e isso não prova nada.              |
| "Já testei na mão."                       | Teste manual não fica registrado nem roda de novo quando o código muda. |
| "Apagar horas de trabalho é desperdício." | Desperdício é manter código em que você não confia.                     |
| "Preciso explorar antes."                 | Tudo bem: jogue a exploração fora e comece com TDD.                     |
| "Difícil de testar."                      | Difícil de testar é difícil de usar. Simplifique a interface.           |
| "O código atual não tem testes."          | Você está melhorando ele: acrescente testes.                            |

## Sinais de alerta: apague e recomece

Código antes do teste. Teste que passa de primeira. Não saber explicar por que o teste falhou. Testes "para depois". "Desta vez é diferente porque…".

## Exemplo: correção de bug

**Bug:** o formulário aceita e-mail vazio.

1. **Vermelho:** `test('recusa e-mail vazio', ...)` esperando o erro `'E-mail obrigatório'`.
2. **Confirme:** rode e veja `esperado 'E-mail obrigatório', recebido undefined`.
3. **Verde:** `if (!dados.email?.trim()) return { erro: 'E-mail obrigatório' };`
4. **Confirme:** rode e veja passar, com a suíte inteira.
5. **Refatore** se fizer sentido.

## Antes de concluir

- [ ] Cada função nova tem um teste.
- [ ] Vi cada teste falhar antes de implementar, pelo motivo esperado.
- [ ] Escrevi o mínimo para passar.
- [ ] A suíte inteira passa, com a saída limpa.
- [ ] Os testes usam código real (mock só quando inevitável).
- [ ] Casos de borda e erros cobertos.

## Travou?

| Problema                | Solução                                                       |
| ----------------------- | ------------------------------------------------------------- |
| Não sei como testar     | Escreva a API que você gostaria de ter. Comece pela asserção. |
| Teste complicado demais | O design está complicado demais. Simplifique a interface.     |
| Tenho que mockar tudo   | O código está acoplado demais. Use injeção de dependência.    |

Achou um bug? Escreva um teste que o reproduz e siga o ciclo. Nunca corrija bug sem teste.
