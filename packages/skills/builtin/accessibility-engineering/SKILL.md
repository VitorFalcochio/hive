---
name: accessibility-engineering
description: 'Use ao auditar uma página ou componente que já existe quanto à acessibilidade (WCAG 2.2 AA) e corrigir o que encontrar: teclado, leitor de tela, contraste, rótulos e foco, antes de entregar.'
license: MIT
metadata:
  origin: Addy Osmani
  author: Addy Osmani
  source: https://github.com/addyosmani/agent-skills/tree/main/skills/accessibility-engineering
  adapted: 'Traduzida para o português e adaptada às ferramentas do Hive'
---

# Engenharia de acessibilidade

Acessibilidade não é acabamento: é exigência legal em muitos lugares, padrão de qualidade e condição para entregar. Esta skill audita interfaces que já existem, separa o que é problema de verdade e corrige. O objetivo é atender a WCAG 2.2 nível AA.

**Não use** para construir componentes do zero (para isso, `frontend-ui-engineering`), nem em mudanças só de backend, linha de comando ou biblioteca sem interface.

## Fase 1: auditoria automática

1. Suba a página: servidor com `run_command` e `background: true`, depois `view_page` para ver a tela e os erros do console.
2. Se o projeto já tem axe-core, pa11y, Lighthouse ou testes de acessibilidade configurados, rode-os. Não instale ferramentas novas só para isso: se não houver, siga direto para a auditoria pelo código e pela tela.
3. Separe o que encontrar por gravidade:
   - **Crítico:** impede o acesso por leitor de tela (imagem informativa sem `alt`, botão sem nome).
   - **Sério:** dificulta muito (contraste baixo, campo sem rótulo).
   - **Moderado:** confunde ou dá trabalho (pulo de nível de título, ARIA redundante).
   - **Menor:** detalhe (idioma faltando num elemento interno).

Confirme cada item olhando o código: ferramenta automática dá alarme falso.

## Fase 2: auditoria pelo código e pela tela

Ferramenta automática é só um primeiro teste, não prova de conformidade.

**Teclado** (leia o código dos elementos interativos):

- Todo elemento clicável é um `<button>` ou `<a href>` de verdade, ou tem `tabindex` e responde a Enter e Espaço.
- Dá para ver onde está o foco: nenhum `outline: none` sem um substituto visível.
- Diálogos fecham com Esc, prendem o foco enquanto abertos e devolvem o foco ao fechar.
- Listas e menus navegam com as setas, seguindo o padrão WAI-ARIA.
- Não existe armadilha de teclado (um ponto de onde o Tab não sai).

**Leitor de tela** (estrutura do HTML):

- Os títulos (`h1` a `h6`) formam uma estrutura lógica, sem pular níveis.
- As regiões têm marcos: `header`, `nav`, `main`, `footer`, com rótulo quando há mais de um do mesmo tipo.
- Os textos dos links fazem sentido fora do contexto ("Ver tênis de corrida", não "Clique aqui").
- Campos de formulário têm rótulo associado, e as mensagens de erro ficam ligadas ao campo (`aria-describedby`).
- Mudanças dinâmicas (item adicionado ao carrinho, erro ao enviar) são anunciadas com `aria-live`.

**Visual** (use `view_page`, em tamanhos diferentes):

- Contraste: 4,5:1 para texto, 3:1 para texto grande e para componentes de interface.
- Com zoom de 200% (ou `width: 640`) o layout não quebra nem sobrepõe.
- Com `prefers-reduced-motion`, as animações param.
- O foco é visível sobre todos os fundos.
- Alvos de toque têm pelo menos 24×24 px, ou espaço suficiente em volta (44×44 é o ideal).

## Fase 3: corrigir

Para cada problema, nesta ordem:

1. **Corrija a causa com HTML semântico:** troque `<div>` por `<button>`, acrescente `<label>`, defina o `alt`.
2. **ARIA só como ponte:** quando o HTML nativo não consegue expressar o padrão.
3. **Confira a correção:** rode de novo a checagem e olhe a tela.

## Lista mínima (WCAG 2.2 AA)

- [ ] Imagens informativas com `alt` descritivo; decorativas com `alt=""`.
- [ ] Todo campo com rótulo; erros explicados em texto, não só em vermelho.
- [ ] `lang` no `<html>`.
- [ ] Título da página (`<title>`) descritivo.
- [ ] Ordem do foco igual à ordem visual.
- [ ] Nada depende só da cor.
- [ ] Vídeo ou áudio que toca sozinho tem controles para parar.

## Desculpas comuns

| Desculpa                           | Realidade                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| "Corrijo a acessibilidade depois." | O problema se multiplica pelos componentes e pode virar processo. Audite antes de entregar. |
| "A ferramenta não achou nada."     | Ferramenta não prova teclado nem leitor de tela. A revisão manual é obrigatória.            |
| "Ponho `aria-label` em tudo."      | ARIA é ponte, não fundação. HTML semântico primeiro; ARIA demais piora.                     |
| "O design system já cuida disso."  | Ele dá peças acessíveis; o jeito de montar decide se o resultado é.                         |

## Sinais de alerta

- Algo que parece clicável e não recebe foco.
- Cor como único indicador de estado.
- Contorno de foco removido sem substituto.
- Campo sem rótulo; botão ou link vazio.
- Título pulando nível.
- Diálogo que não prende nem devolve o foco.
- Texto com contraste baixo (principalmente no hover, desativado e placeholder).

## Antes de concluir

- [ ] Nenhum problema crítico ou sério sobrando.
- [ ] Teclado funciona em tudo (Tab, Enter, Esc, setas).
- [ ] Contraste confere.
- [ ] Todos os campos têm rótulo e todas as imagens têm `alt` adequado.
- [ ] Mudanças dinâmicas são anunciadas.
- [ ] A página funciona com 200% de zoom.
- [ ] No `finish`, diga o que foi conferido de verdade e o que não deu para testar (por exemplo, um leitor de tela real). Nunca dê como verificado o que não foi.
