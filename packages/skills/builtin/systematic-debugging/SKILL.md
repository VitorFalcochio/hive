---
name: systematic-debugging
description: 'Use diante de qualquer bug, teste falhando ou comportamento inesperado, antes de propor uma correção: acha a causa raiz em quatro fases em vez de chutar.'
license: MIT
metadata:
  origin: Superpowers
  author: Jesse Vincent
  source: https://github.com/obra/superpowers/tree/main/skills/systematic-debugging
  adapted: 'Traduzida para o português e adaptada às ferramentas do Hive'
---

# Depuração sistemática

**Princípio:** encontre SEMPRE a causa raiz antes de tentar corrigir. Corrigir o sintoma é falhar.

## A lei de ferro

```
NENHUMA CORREÇÃO SEM INVESTIGAR A CAUSA RAIZ PRIMEIRO
```

Se você não terminou a Fase 1, não pode propor correção.

## Quando usar

Em QUALQUER problema técnico: teste falhando, bug, comportamento inesperado, lentidão, build quebrado, integração que não conversa.

**Principalmente quando:**

- Há pressa (a pressa torna o chute tentador).
- "Só uma correçãozinha" parece óbvia.
- Você já tentou várias correções, ou a última não funcionou.
- Você não entende o problema por completo.

Não pule porque o problema "parece simples": bugs simples também têm causa raiz, e o processo é rápido para eles.

## As quatro fases

Termine cada fase antes de passar para a próxima.

### Fase 1: investigar a causa raiz

**ANTES de qualquer correção:**

1. **Leia a mensagem de erro com atenção.** Não pule erros nem avisos: muitas vezes eles trazem a solução exata. Leia a pilha de chamadas inteira e anote linhas, arquivos e códigos de erro.
2. **Reproduza de forma consistente.** Dá para provocar o erro sempre? Quais são os passos exatos? Se não reproduz, colete mais dados em vez de chutar.
3. **Veja o que mudou.** O que mudou que poderia causar isso? Diferenças recentes, dependências novas, configuração, ambiente.
4. **Em sistemas com várias camadas, colete evidência em cada fronteira.** Quando o problema passa por várias partes (navegador → API → serviço → banco), registre o que entra e o que sai de cada camada, rode uma vez e veja **onde** quebra. Só então investigue aquela camada.
5. **Rastreie o dado até a origem.** Quando o erro aparece fundo na pilha: de onde veio o valor errado? Quem chamou com ele? Suba até achar a fonte e corrija lá, não no sintoma. A técnica completa está em `root-cause-tracing.md`.

**No Hive:**

- Para página web, abra com `view_page` e leia os erros do console antes de mexer no código.
- Servidor de desenvolvimento roda com `run_command` e `background: true`. Um servidor em primeiro plano trava a tarefa até o tempo acabar.
- Consulte o Nectar com `nectar_search`: talvez outro agente já tenha descoberto a causa.

### Fase 2: analisar o padrão

1. **Ache exemplos que funcionam** no mesmo projeto: o que é parecido com o que quebrou e funciona?
2. **Compare com a referência.** Se você está aplicando um padrão, leia a implementação de referência INTEIRA, linha por linha.
3. **Liste as diferenças** entre o que funciona e o que quebrou, por menores que sejam. Não assuma que "isso não pode importar".
4. **Entenda as dependências:** que outras partes, configurações e premissas o código precisa?

### Fase 3: hipótese e teste

1. **Uma hipótese só, escrita:** "Acho que X é a causa raiz porque Y." Seja específico.
2. **Teste com a menor mudança possível**, uma variável por vez.
3. **Confira antes de seguir.** Funcionou? Fase 4. Não funcionou? Nova hipótese. NÃO empilhe correções.
4. **Quando não souber,** diga "não entendo X". Não finja; pesquise mais.

### Fase 4: implementar

1. **Crie um teste que falha** reproduzindo o bug, o mais simples possível. Ele precisa existir antes da correção (veja a skill `test-driven-development`).
2. **Faça uma correção só,** na causa raiz. Nada de "já que estou aqui" nem refatoração junto.
3. **Confira:** o teste passa agora? Os outros continuam passando? O problema original sumiu? Siga a skill `verification-before-completion` antes de dizer que resolveu.
4. **Se a correção não funcionou:** pare e conte quantas tentativas fez. Menos de 3: volte à Fase 1 com o que aprendeu. **3 ou mais: pare e questione a arquitetura** (abaixo).

### Três correções falharam: questione a arquitetura

Sinais de problema de arquitetura:

- Cada correção revela um novo acoplamento ou problema em outro lugar.
- As correções exigem uma "refatoração enorme".
- Cada correção cria sintomas novos em outro ponto.

Pare e pergunte: esse padrão faz sentido? Estamos insistindo só por inércia? Não tente a quarta correção: explique a situação no `finish` para o usuário decidir.

## Sinais de alerta: PARE e volte à Fase 1

Se você se pegar pensando:

- "Correção rápida agora, investigo depois."
- "Vou mudar X e ver se funciona."
- "Vou fazer várias mudanças e rodar os testes."
- "Pulo o teste, confiro na mão."
- "Deve ser X, vou corrigir."
- "Não entendo direito, mas isso pode funcionar."
- "Só mais uma tentativa" (depois de 2 ou mais).

## Desculpas comuns

| Desculpa                                | Realidade                                                               |
| --------------------------------------- | ----------------------------------------------------------------------- |
| "É simples, não precisa de processo."   | Problema simples também tem causa raiz, e o processo é rápido para ele. |
| "É urgente, não dá tempo."              | Depurar com método é MAIS rápido que tentativa e erro.                  |
| "Testo depois de ver que funcionou."    | Correção sem teste não se sustenta.                                     |
| "Várias correções juntas poupam tempo." | Não dá para saber o que funcionou, e criam bugs novos.                  |
| "Estou vendo o problema, vou corrigir." | Ver o sintoma não é entender a causa.                                   |

## Quando não há causa raiz

Se a investigação mostrar que o problema é mesmo do ambiente, de tempo ou externo: registre o que investigou, trate o caso (nova tentativa, tempo limite, mensagem de erro clara) e deixe um registro para investigar no futuro. Mas 95% dos casos de "não tem causa raiz" são investigação incompleta.

## Técnicas de apoio (nesta skill)

- `root-cause-tracing.md`: rastrear o bug para trás na pilha até o gatilho original.
- `defense-in-depth.md`: validar em várias camadas depois de achar a causa.
- `condition-based-waiting.md`: trocar esperas fixas por espera até a condição acontecer.
