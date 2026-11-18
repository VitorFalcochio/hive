---
name: writing-plans
description: 'Use ao transformar um objetivo ou especificação em plano de várias tarefas, antes de qualquer código: registra as decisões que os agentes não conseguem tomar sozinhos (arquivos, nomes, assinaturas, valores, testes).'
license: MIT
metadata:
  origin: Superpowers
  author: Jesse Vincent
  source: https://github.com/obra/superpowers/tree/main/skills/writing-plans
  adapted: 'Traduzida para o português e adaptada ao planejamento da Queen no Hive'
---

# Escrever planos

Escreva o plano para agentes que nunca viram este projeto nem este pedido. Eles escrevem bom código na linguagem do projeto quando sabem a interface exata e o teste exato, e fazem escolhas razoáveis onde o plano deixa espaço. O que eles **não** têm como saber é o que você decidiu: quais arquivos, quais nomes e assinaturas, quais valores do pedido, quais testes provam cada tarefa. Registre isso. Tarefas pequenas. Sem repetição (DRY). Nada que não foi pedido (YAGNI). Teste primeiro (TDD).

**No Hive** cada tarefa vai para um agente diferente, muitas vezes ao mesmo tempo, e cada agente vê **só a sua tarefa**. Tudo o que um precisa saber do outro tem que estar escrito nela.

## Confira o escopo

Se o pedido cobre vários subsistemas independentes, separe as tarefas por subsistema, cada um entregando algo que funciona e pode ser testado sozinho.

## Estrutura de arquivos primeiro

Antes de definir as tarefas, mapeie quais arquivos serão criados ou alterados e qual a responsabilidade de cada um. É aqui que a divisão fica decidida.

- Unidades com fronteiras claras e interfaces bem definidas. Cada arquivo com uma responsabilidade.
- Arquivos menores e focados são mais fáceis de editar com segurança do que arquivos grandes que fazem tudo.
- O que muda junto fica junto: divida por responsabilidade, não por camada técnica.
- Em projeto existente, siga os padrões que já estão lá. Não reestruture por conta própria.
- **Duas tarefas em paralelo não editam o mesmo arquivo.** Se precisarem, uma depende da outra.

Se você tem ferramentas, olhe o projeto antes (`list_dir` na raiz, README, `package.json`) e cite arquivos reais. Um plano com caminhos reais vale muito mais que um genérico. Consulte o Nectar com `nectar_search`: pode já haver decisões registradas sobre o assunto.

## O tamanho certo da tarefa

Uma tarefa é a menor unidade que tem o seu próprio ciclo de teste e que um revisor poderia aprovar ou recusar sozinha. Junte preparação, configuração, esqueleto e documentação na tarefa cuja entrega precisa deles. Divida só onde um revisor poderia recusar uma tarefa e aprovar a vizinha. Cada tarefa termina com uma entrega que dá para testar sozinha. Se a descrição precisa de "e também", provavelmente são duas.

## O que cada tarefa leva

- **Arquivos:** criar `caminho/exato`, alterar `caminho/exato`, teste em `caminho/do/teste`.
- **Interfaces:**
  - _Usa:_ o que pega de tarefas anteriores, com as assinaturas exatas.
  - _Produz:_ o que tarefas seguintes vão usar: nomes exatos de funções, parâmetros e tipos de retorno. É assim que um agente fica sabendo dos nomes que o vizinho usa.
- **Critérios de aceite verificáveis:** o teste que prova a tarefa (nome e asserções, com os valores exatos do pedido) e o comando que deve passar, com o resultado esperado. Ex.: "`npm test -- carrinho` passa; o total de 2 itens de R$ 100,00 aparece como R$ 200,00".
- **Dependências:** de quais tarefas esta precisa, e só delas. Menos dependências, mais paralelismo.

Um passo está bom quando o agente consegue escrever **uma** coisa razoável a partir dele: sem ambiguidade, não completo. A assinatura e o teste dizem o quê; o corpo da função é com o agente. Escreva um trecho de código só para um algoritmo que a assinatura e o teste não determinam, ou para um texto exato que o pedido fixa.

**Os dois erros opostos:**

- Linhas que não decidem nada: "a definir", "tratar casos de borda", "validar adequadamente", "escrever testes para o acima", um tipo que nenhuma tarefa define.
- Um plano maior que o código que ele descreve: aí você escreveu o código em vez de planejar.

## Restrições globais e pontos de atenção

- **Restrições do projeto inteiro:** versões mínimas, limites de dependência, regras de nomes e textos, plataforma. Uma linha cada, com os valores exatos do pedido. Valem para todas as tarefas.
- **Pontos de atenção:** as entradas ou falhas que o pedido implica mas nenhum teste cobre, e que mais provavelmente vão incomodar quem usar o software (campo vazio, lista vazia, valor muito grande, sem internet, tela de celular). Para cada uma, acrescente o teste à tarefa dona do código.

## Revisão final (você mesmo)

Depois de escrever o plano inteiro, releia o pedido com olhos novos:

1. **Cobertura:** cada requisito do pedido tem uma tarefa? Liste os buracos e crie as tarefas.
2. **Passos:** cada passo leva o agente a escrever uma coisa razoável, e nada mais?
3. **Consistência:** os nomes, tipos e assinaturas das tarefas seguintes batem com os definidos antes? `limparCamadas()` numa tarefa e `limparTodasCamadas()` em outra é bug.
4. **Paralelismo:** duas tarefas simultâneas mexem no mesmo arquivo? Crie a dependência.
5. **Proporção:** o plano ficou muito maior que o pedido? Troque corpos de função por assinaturas, nomes de teste e asserções.

Encontrou problema? Corrija na hora e siga em frente.
