---
name: verification-before-completion
description: 'Use antes de dizer que um trabalho está pronto, corrigido ou passando, e antes de chamar finish: exige rodar a verificação e ler o resultado antes de afirmar qualquer sucesso. Evidência antes de afirmação, sempre.'
license: MIT
metadata:
  origin: Superpowers
  author: Jesse Vincent
  source: https://github.com/obra/superpowers/tree/main/skills/verification-before-completion
  adapted: 'Traduzida para o português e adaptada às ferramentas do Hive'
---

# Verificar antes de concluir

**Princípio:** evidência antes de afirmação, sempre.

## A lei de ferro

```
NENHUMA AFIRMAÇÃO DE CONCLUSÃO SEM EVIDÊNCIA NOVA DE VERIFICAÇÃO
```

Se você não rodou o comando de verificação agora, não pode dizer que passa.

## O portão

```
ANTES de afirmar qualquer estado ou demonstrar satisfação:

1. IDENTIFIQUE: que comando prova essa afirmação?
2. RODE: o comando COMPLETO, agora.
3. LEIA: a saída inteira, o código de saída, quantas falhas.
4. CONFIRA: a saída confirma a afirmação?
   - Se NÃO: diga o estado real, com a evidência.
   - Se SIM: faça a afirmação, COM a evidência.
5. SÓ ENTÃO: afirme.

Pular um passo é mentir, não verificar.
```

## Descubra os comandos do projeto

Procure em `package.json` (scripts), `Makefile`, `pyproject.toml`, `Cargo.toml`, `go.mod` ou no README. Use os comandos do próprio projeto; não invente outros nem instale ferramentas novas.

Ordem: tipos/compilação → testes da mudança → suíte completa (se for rápida) → lint/formatação.

## O que prova o quê

| Afirmação                   | Precisa de                                        | Não basta                          |
| --------------------------- | ------------------------------------------------- | ---------------------------------- |
| Os testes passam            | Saída do comando de teste: 0 falhas               | Execução antiga, "deve passar"     |
| Lint limpo                  | Saída do lint: 0 erros                            | Checagem parcial                   |
| Build funciona              | Comando de build: código de saída 0               | Lint passando, "o log parece bom"  |
| Bug corrigido               | O sintoma original testado: passa                 | Código mudou, "deve ter resolvido" |
| Teste de regressão funciona | Ciclo vermelho-verde confirmado                   | Teste passou uma vez               |
| A página funciona           | `view_page`: tela renderizada e console sem erros | "O HTML está certo"                |
| Requisitos atendidos        | Checklist item por item contra a tarefa           | Testes passando                    |

**No Hive:** servidor para testar a página sobe com `run_command` e `background: true`. Depois confira com `view_page` e olhe os erros do console.

## Sinais de alerta: PARE

- Usar "deve", "provavelmente", "parece que".
- Comemorar antes de verificar ("Pronto!", "Perfeito!").
- Chamar `finish` sem ter rodado a verificação.
- Confiar no relato de sucesso de um soldado sem conferir os arquivos.
- Achar que "só desta vez" pode.

## Desculpas comuns

| Desculpa                         | Realidade                  |
| -------------------------------- | -------------------------- |
| "Deve funcionar agora."          | RODE a verificação.        |
| "Estou confiante."               | Confiança não é evidência. |
| "O lint passou."                 | Lint não compila o código. |
| "O soldado disse que deu certo." | Confira você mesmo.        |
| "Checagem parcial basta."        | Parcial não prova nada.    |

## Teste de regressão (vermelho-verde)

```
✅ Escreve o teste → roda (passa) → desfaz a correção → roda (TEM que falhar) → refaz → roda (passa)
❌ "Escrevi um teste de regressão" (sem ter visto ele falhar)
```

## Antes do finish

Releia sua mudança:

- Ficou código de depuração, `console.log`, TODO seu ou arquivo temporário?
- Mudou algo que a tarefa não pediu? Desfaça.
- O estilo (nomes, aspas, recuo, idioma dos comentários) bate com o resto do arquivo?

No `finish`, relate:

- O que mudou, por arquivo.
- Os comandos que rodou e o resultado **real** de cada um.
- O que não conseguiu verificar, e por quê.

Nunca diga que os testes passaram se você não os rodou. Falha relatada com clareza vale mais que sucesso inventado.
