---
name: performance-optimization
description: 'Use quando há requisito de desempenho, suspeita de lentidão ou regressão, tempo de carregamento ou Core Web Vitals ruins, consultas N+1 ou um gargalo encontrado: mede antes, corrige o gargalo real e mede de novo.'
license: MIT
metadata:
  origin: Addy Osmani
  author: Addy Osmani
  source: https://github.com/addyosmani/agent-skills/tree/main/skills/performance-optimization
  adapted: 'Traduzida para o português e adaptada às ferramentas do Hive'
---

# Otimização de desempenho

Meça antes de otimizar. Otimizar sem medir é chutar, e o chute leva a otimização prematura, que acrescenta complexidade sem melhorar o que importa. Meça, ache o gargalo real, corrija, meça de novo. Otimize só o que a medição prova que importa.

## Quando usar

- O pedido tem requisito de desempenho (tempo de carregamento, tempo de resposta).
- Alguém relata lentidão.
- Os Core Web Vitals estão abaixo do aceitável.
- Você suspeita que uma mudança deixou algo mais lento.
- A funcionalidade lida com muitos dados ou muito acesso.

**Quando NÃO usar:** sem evidência de problema. A complexidade da otimização prematura custa mais do que o desempenho que ela ganha.

## Metas dos Core Web Vitals

| Métrica                          | Bom      | Precisa melhorar | Ruim     |
| -------------------------------- | -------- | ---------------- | -------- |
| **LCP** (maior conteúdo visível) | ≤ 2,5 s  | ≤ 4,0 s          | > 4,0 s  |
| **INP** (resposta à interação)   | ≤ 200 ms | ≤ 500 ms         | > 500 ms |
| **CLS** (mudança de layout)      | ≤ 0,1    | ≤ 0,25           | > 0,25   |

## O processo

```
1. MEDIR       → linha de base com números reais
2. IDENTIFICAR → o gargalo de verdade (não o suposto)
3. CORRIGIR    → só esse gargalo
4. CONFERIR    → medir de novo; manter ou desfazer
5. PROTEGER    → teste ou monitoramento para não piorar de novo
```

### 1. Medir

- **Frontend:** use o que o projeto já tem (Lighthouse, um script de medição, a biblioteca `web-vitals`). No Hive, `view_page` mostra a tela e os erros, mas não mede tempo: para números, rode a ferramenta do projeto com `run_command`.
- **Backend:** registre o tempo das requisições e das consultas (`console.time('consulta')` / `console.timeEnd('consulta')`), ou o log de consultas do banco com o tempo de cada uma.

**Por onde começar, conforme o sintoma:**

```
O que está lento?
├── O primeiro carregamento
│   ├── Pacote JavaScript grande? → meça o tamanho, veja a divisão de código
│   ├── Servidor demora a responder? → meça o tempo até o primeiro byte; perfile o backend
│   └── Recursos bloqueando a renderização? → veja CSS e JS que travam o carregamento
├── A interação
│   ├── A tela trava ao clicar? → procure tarefas longas (> 50 ms) no navegador
│   └── Digitar num campo engasga? → veja renderizações demais
├── Depois de navegar → tempo das chamadas à API, chamadas em cascata
└── Backend / API
    ├── Uma rota lenta? → consultas e índices dessa rota
    ├── Todas lentas? → pool de conexões, memória, CPU
    └── Lento às vezes? → disputa de travas, coleta de lixo, dependências externas
```

### 2. Identificar o gargalo

| Sintoma           | Causa provável                                                     |
| ----------------- | ------------------------------------------------------------------ |
| LCP lento         | Imagens grandes, recursos bloqueando, servidor lento               |
| CLS alto          | Imagens sem dimensões, conteúdo que chega tarde, troca de fonte    |
| INP ruim          | JavaScript pesado na thread principal, atualizações grandes no DOM |
| API lenta         | Consultas N+1, falta de índice, consulta mal escrita               |
| Memória crescendo | Referências presas, cache sem limite                               |
| CPU no talo       | Cálculo pesado síncrono, regex com retrocesso excessivo            |

### 3. Corrigir só o gargalo

Os suspeitos de sempre. Cada um tem um exemplo pronto em `references/optimization-patterns.md` (abra só a seção que precisar):

**Backend**

- **Consultas N+1:** uma consulta por linha é o gargalo mais comum. Traga a relação na mesma consulta (join/include), não dentro do laço.
- **Busca sem limite:** toda lista pagina, com limite e ordem estável.
- **Consulta que ignora o índice:** "adicionar um índice" é o chute; `EXPLAIN ANALYZE` é a medição. Indexe pelo formato da consulta (colunas de igualdade primeiro, depois a de intervalo ou ordenação). Cada índice custa em toda escrita. Rode o plano de novo depois: índice que não mudou o plano é desfeito.
- **Pool de conexões esgotado:** sinal típico é _todas_ as rotas ficarem lentas ao mesmo tempo, esperando conexão. Um pool por processo, dimensionado para que `processos × máximo` caiba no limite do banco. Pool maior não é mais rápido.
- **Falta de cache:** guarde em cache o que é caro de produzir e lido muito mais vezes do que muda. Tudo que muda a resposta entra na chave (cliente, idioma, permissões): uma chave sem o usuário é como os dados de um usuário vazam para outro. Defina quanto tempo de dado velho é aceitável. Nunca guarde em cache o que precisa estar atualizado (saldo, permissões, estoque no checkout).

**Frontend**

- **Imagens:** toda imagem com `width` e `height` (evita CLS). A imagem principal com `fetchpriority="high"`, formatos modernos (AVIF, WebP) e `srcset`; as de baixo com `loading="lazy"` e `decoding="async"`.
- **Renderizações demais:** objeto ou função criados na renderização são referências novas toda vez. Tire constantes de dentro do componente; `React.memo` e `useMemo` só onde a medição mostra custo.
- **Pacote grande:** o ganho real está em dividir o código por rota e carregar sob demanda o que é pesado e pouco usado.

### 4. Conferir: manter ou desfazer

Uma correção é hipótese até você medir de novo.

- **Meça do mesmo jeito da linha de base:** mesmo comando, mesmas condições. Cache frio contra cache quente mede o cache, não a mudança.
- **Uma mudança por vez.** Três otimizações juntas dão um número só, e não dá para saber qual ajudou.
- **Supere o ruído.** Repita a medição: um ganho de 3% dentro de uma variação de ±5% não é ganho.

| Resultado                               | O que fazer                                            |
| --------------------------------------- | ------------------------------------------------------ |
| Melhorou além do ruído, testes passando | **Manter**, com os números de antes e depois no relato |
| Igual (dentro do ruído)                 | **Desfazer**                                           |
| Pior                                    | **Desfazer**                                           |
| Melhorou, mas um teste quebrou          | **Desfazer**: é regressão disfarçada de ganho          |

**"Neutro" se desfaz, não se mantém.** Código que fica, alguém mantém para sempre. A correção tem que se pagar. E a correção vem antes do número: uma "otimização" que ganha pulando trabalho que o produto precisa (uma validação, um `await` necessário) é regressão.

**Registre todas as tentativas, inclusive as desfeitas,** no relato do `finish` e, quando valer para o projeto, no Nectar (`nectar_propose`, tipo "Descoberta"). Assim ninguém tenta de novo uma ideia que já não funcionou.

### 5. Proteger

Proteja a métrica que o usuário sente (a que justificou a correção), com um orçamento no build ou um teste. Orçamentos típicos:

```
JavaScript inicial: < 200 KB comprimido
CSS: < 50 KB comprimido
Imagem acima da dobra: < 200 KB cada
Fontes: < 100 KB no total
Resposta da API: < 200 ms (p95)
```

## Desculpas comuns

| Desculpa                                | Realidade                                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| "Otimizo depois."                       | Dívida de desempenho acumula. Corrija já os erros óbvios; deixe a micro-otimização para depois. |
| "No meu computador está rápido."        | O seu computador não é o do usuário.                                                            |
| "A otimização é óbvia."                 | Se você não mediu, não sabe.                                                                    |
| "A consulta está lenta, põe um índice." | Leia o plano primeiro.                                                                          |
| "É só pôr em cache."                    | Cache de algo que já é barato não ganha nada e cria bug de dado velho.                          |
| "Não ajudou muito, mas não atrapalha."  | Neutro se desfaz.                                                                               |

## Antes de concluir

- [ ] Há números de antes e depois.
- [ ] A medição depois foi feita do mesmo jeito que a de antes.
- [ ] A melhora supera a variação entre medições.
- [ ] O que não melhorou foi desfeito.
- [ ] O gargalo específico foi identificado e tratado.
- [ ] Nenhuma consulta N+1 nova.
- [ ] Todo índice novo tem plano antes e depois que o justifica.
- [ ] Todo cache novo diz o que vai na chave e quanto tempo de dado velho aceita.
- [ ] Os testes continuam passando.
