---
name: frontend-design
description: 'Use ao criar uma interface nova ou repaginar uma existente: dá direção visual com personalidade (paleta, tipografia, layout e textos) para a tela não parecer modelo pronto nem gerada por IA.'
license: Apache-2.0
metadata:
  origin: Anthropic
  author: Anthropic
  source: https://github.com/anthropics/skills/tree/main/skills/frontend-design
  adapted: 'Traduzida para o português e adaptada às ferramentas do Hive (arquivo modificado em relação ao original)'
---

# Design de interface

Encare o trabalho como o líder de design de um estúdio conhecido por dar a cada cliente uma identidade visual que não se confunde com a de ninguém. Este cliente já recusou propostas que pareciam clichê ou modelo pronto e está pagando por um ponto de vista próprio: faça escolhas deliberadas e com opinião sobre paleta, tipografia e layout, específicas para este pedido, e arrisque quando fizer sentido.

**Se o projeto já tem um design system** (tokens de cor, tema, componentes), siga-o: ele vem antes de tudo o que está aqui. Esta skill preenche o que estiver em aberto.

## Parta do assunto

Se o pedido não diz qual é o produto ou o assunto, defina você mesmo antes de desenhar: um assunto concreto, o público e a função principal da tela. O setor, o assunto, os materiais e o vocabulário desse mundo são de onde vêm as escolhas visuais marcantes: o site de uma loja de tênis de corrida é muito diferente de um painel para analistas financeiros. Use o conteúdo e o assunto reais do pedido do começo ao fim, e consulte o Nectar (`nectar_search`) para saber de decisões de marca já registradas.

## Princípios

**A primeira dobra.** É a primeira coisa que as pessoas veem. Abra com o que há de mais característico no mundo do assunto, na forma mais adequada: um título, uma imagem, uma animação, uma demonstração, um momento interativo. Escolha com intenção: "número grande com rótulo pequeno, estatísticas e um gradiente" é o tratamento padrão; use só se for mesmo a melhor opção.

**A tipografia carrega a personalidade.** Uma família ou duas; se forem duas, bem diferentes entre si. Escolha as fontes de propósito, não as que você usaria em qualquer outro projeto. Defina uma escala tipográfica clara, com pesos, larguras e espaçamentos intencionais. Quando o texto é título ou elemento visual, o próprio tratamento tipográfico faz parte do design.

**Linhas com menos de 80 caracteres.** Serifadas podem ser um pouco mais longas, com um pouco mais de entrelinha.

**Evite estes tratamentos tipográficos, os sinais mais comuns de página gerada:**

- Destacar uma única palavra do título com itálico, negrito ou outra cor.
- Rótulos em MAIÚSCULAS.
- Rótulos desnecessários acima do conteúdo.

**Estrutura visual é informação.** Contornos, bordas, numeração, divisores e rótulos devem dizer algo verdadeiro sobre o conteúdo, não enfeitar. Numeração (01 / 02 / 03) só se o conteúdo for de fato uma sequência, como um passo a passo ou uma linha do tempo.

**Movimento com parcimônia.** Um único momento orquestrado (uma sequência na abertura, uma revelação) funciona melhor que efeitos espalhados. Seções que surgem deslizando uma a uma e hover em todo card são o padrão genérico e parecem feitos por IA. Movimento que responde a uma ação da pessoa (abrir, expandir, confirmar) é bem-vindo quando mostra o que mudou.

**Os textos também são design.** Muitas vezes o pedido não traz conteúdo real e cabe a você escrever. Texto genérico deixa a tela com cara de modelo tanto quanto o visual (veja a última seção).

## Processo: planejar, revisar contra o pedido, construir, criticar

Para calibrar: o design gerado por IA hoje se concentra em alguns traços:

1. Fundo creme quente (perto de `#F4F1EA`) com serifada de alto contraste e destaque terracota.
2. Fundo quase preto com um único destaque verde-limão ou vermelhão.
3. Layout de jornal, com fios finos, cantos retos e colunas densas.
4. O kit de cards de SaaS: conteúdo picado em cards iguais e arredondados, o mesmo raio de borda em tudo, a mesma sombra cinza suave e gradientes como enfeite.
5. Acessórios de modelo que aparecem em qualquer assunto: rótulo em MAIÚSCULAS espaçadas acima de todo título, informações unidas por pontos ("A · B · C"), quase preto (`#111`) no lugar do preto, fonte monoespaçada em rótulos pequenos, uma seta "→" no fim de links e botões.

Todos esses traços servem para algum pedido, mas são padrões, não escolhas. Onde o pedido define a direção visual, siga exatamente o que ele diz, mesmo que peça um desses visuais. Onde ele deixa em aberto, não gaste essa liberdade num desses padrões.

**Trabalhe em duas passadas.**

1. **Plano curto**, com um sistema de tokens:
   - **Cor:** a paleta base em 4 a 6 cores nomeadas, com o código hexadecimal.
   - **Tipografia:** as fontes e o papel de cada uma.
   - **Layout:** o conceito em uma frase e um rascunho simples; alinhamento à esquerda, centralizado ou justificado.
   - **Princípios:** o que torna esta página única.
2. **Revise o plano contra o pedido antes de construir.** Se alguma parte parece o padrão que você faria para qualquer página parecida, troque, e diga o que mudou e por quê. Só então escreva o código, seguindo o plano revisado.

Ao escrever o CSS, cuidado com a especificidade dos seletores: é fácil criar classes que se anulam (um seletor de tipo como `.secao` e um de elemento como `.cta` brigando pelo espaçamento).

## Contenção e autocrítica

Gaste a ousadia num lugar só. Deixe um elemento ser o memorável e mantenha tudo em volta quieto e disciplinado; corte qualquer enfeite que não serve ao pedido.

Construa acima de um piso de qualidade, sem anunciar: responsivo até o celular, foco visível no teclado, `prefers-reduced-motion` respeitado, contraste acessível, paleta harmônica.

**Critique enquanto constrói, olhando a tela.** No Hive: suba o servidor com `run_command` e `background: true` e abra com `view_page`, no tamanho de computador e no de celular (`width: 375`). Uma captura de tela vale mais que mil tokens. Siga o conselho de Chanel: antes de sair de casa, olhe no espelho e tire um acessório.

## Sobre os textos no design

As palavras estão na tela por um motivo só: tornar mais fácil entender e usar. Elas são conteúdo, não decoração. Antes de escrever, pergunte o que a tela precisa dizer e qual a melhor forma de dizer, para ajudar a pessoa a se orientar.

- **Escreva do lado de quem usa.** Nomeie as coisas pelo que a pessoa entende, em linguagem simples, não pelo jeito que o sistema é construído: a pessoa gerencia _notificações_, não _configuração de webhook_. Diga o que algo é ou faz, sem vender.
- **Voz ativa.** O botão diz exatamente o que acontece: "Salvar alterações", não "Enviar". Uma ação mantém o mesmo nome no fluxo inteiro: o botão "Publicar" gera o aviso "Publicado".
- **Erro e vazio são momentos de orientar.** Explique o que deu errado e como resolver, na voz da interface. Erros não pedem desculpa e nunca são vagos. Uma tela vazia é um convite para agir.
- **Tom de conversa:** verbos simples, só a primeira letra maiúscula, sem enchimento, no tom da marca e do público. Cada texto faz um trabalho só.
- **Escreva na língua do público.** Para um site brasileiro, português do Brasil, com preços em reais (R$ 1.299,90).
