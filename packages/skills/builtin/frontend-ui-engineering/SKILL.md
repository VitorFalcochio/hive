---
name: frontend-ui-engineering
description: 'Use ao construir ou mudar telas, páginas, componentes, layouts responsivos ou estado da interface: entrega interface com qualidade de produção, acessível e com cara de feita por gente, não por IA.'
license: MIT
metadata:
  origin: Addy Osmani
  author: Addy Osmani
  source: https://github.com/addyosmani/agent-skills/tree/main/skills/frontend-ui-engineering
  adapted: 'Traduzida para o português e adaptada às ferramentas do Hive'
---

# Engenharia de interface

Construa interfaces com qualidade de produção: acessíveis, rápidas e bem acabadas. O objetivo é uma tela que pareça feita por um engenheiro atento ao design numa empresa de ponta, e não gerada por IA. Isso quer dizer seguir o design do projeto, acessibilidade de verdade, interações bem pensadas e nada da "estética de IA".

Para a direção visual (paleta, tipografia, personalidade), abra também a skill `frontend-design`. Para acessibilidade a fundo, a skill `accessibility-engineering`.

## Confira com o que o projeto tem

Rode os comandos de teste, tipos e lint do próprio projeto. Não instale framework, executor de testes ou checador de tipos só para conferir o seu trabalho. Se o projeto não tem nada disso, revise o código pela lista do fim e diga o que não conseguiu rodar.

**No Hive, sempre veja a tela:** suba o servidor de desenvolvimento com `run_command` e `background: true` (`npm run dev`, `python -m http.server 8000`…), abra com `view_page` e olhe a captura de tela e os erros do console. Para conferir no celular, abra com `width: 375`.

## Arquitetura de componentes

**Tudo do componente junto:**

```
src/components/ListaDeTarefas/
  ListaDeTarefas.tsx        # o componente
  ListaDeTarefas.test.tsx   # testes
  use-lista-de-tarefas.ts   # hook, se o estado for complexo
```

**Composição em vez de configuração:**

```tsx
// ✅ Componível
<Card>
  <CardHeader><CardTitle>Tarefas</CardTitle></CardHeader>
  <CardBody><ListaDeTarefas tarefas={tarefas} /></CardBody>
</Card>
// ❌ Configurado demais
<Card titulo="Tarefas" varianteCabecalho="grande" espacamento="md" conteudo={...} />
```

**Componentes focados:** um componente faz uma coisa. Passou de umas 200 linhas, divida.

**Busca de dados separada da apresentação:** um componente "container" busca os dados e trata carregando, erro e vazio; o componente de apresentação só desenha.

## Estado

Use o mais simples que funciona:

| Tipo                                  | Para quê                                             |
| ------------------------------------- | ---------------------------------------------------- |
| Estado local (`useState`)             | Estado de um componente só                           |
| Estado elevado                        | Compartilhado entre 2 ou 3 componentes irmãos        |
| Context                               | Tema, login, idioma (muita leitura, pouca escrita)   |
| Estado na URL                         | Filtros, paginação, algo que se compartilha por link |
| Estado do servidor (React Query, SWR) | Dados remotos com cache                              |
| Store global (Zustand, Redux)         | Estado complexo usado no app todo                    |

Evite passar props por mais de 3 níveis de componentes que não as usam: use context ou reorganize a árvore.

## Siga o design do projeto

### Evite a estética de IA

| O padrão da IA             | Por que é problema                    | Qualidade de produção                   |
| -------------------------- | ------------------------------------- | --------------------------------------- |
| Roxo e índigo em tudo      | Todo app fica igual                   | A paleta real do projeto                |
| Gradiente demais           | Ruído visual                          | Cor chapada ou gradiente sutil          |
| Tudo muito arredondado     | Ignora a hierarquia de cantos         | O raio de borda do projeto, consistente |
| Seção "hero" genérica      | Sem ligação com o conteúdo            | Layout a partir do conteúdo             |
| Texto "lorem ipsum"        | Esconde problemas de tamanho e quebra | Conteúdo realista                       |
| Espaçamento enorme em tudo | Destrói a hierarquia                  | Escala de espaçamento consistente       |
| Grade de cards padrão      | Ignora a prioridade da informação     | Layout com propósito                    |
| Sombra pesada              | Compete com o conteúdo                | Sombra sutil ou nenhuma                 |

### Espaçamento

Use a escala do projeto (por exemplo, múltiplos de 4px). Nada de `padding: 13px` ou `margin-top: 2.3rem`.

### Tipografia

`h1` é o título da página (um por página), `h2` o de seção, `h3` o de subseção. Não pule níveis nem use estilo de título em algo que não é título.

### Cor

- Use os tokens do projeto (`--texto`, `--superficie`), não códigos de cor soltos.
- Contraste suficiente: 4,5:1 para texto normal, 3:1 para texto grande.
- Nunca use só a cor para passar informação: junte ícone ou texto.

## Acessibilidade (o básico, sempre)

- **Teclado:** todo elemento interativo funciona pelo teclado. Use `<button>` para botão, não `<div onClick>`.
- **Rótulos:** botões só com ícone levam `aria-label` ("Fechar"); campos de formulário têm `<label for>`.
- **Foco:** ao abrir um diálogo, o foco vai para dentro dele e fica preso lá; ao fechar, volta para onde estava.
- **Menus, diálogos, abas e listas:** siga o padrão WAI-ARIA correspondente.

## Estados que nunca podem faltar

Carregando, vazio, erro e sucesso. Nada de tela em branco:

- **Vazio:** diga o que vai aparecer ali e como criar o primeiro item, com o botão.
- **Erro:** diga o que deu errado e ofereça "Tentar de novo".
- **Carregando:** esqueleto no formato do conteúdo, não um spinner no meio do nada.

## Responsivo

Pense no celular primeiro e depois expanda. Confira em 320px, 768px, 1024px e 1440px. Nada de rolagem horizontal na página.

## Desculpas comuns

| Desculpa                               | Realidade                                                  |
| -------------------------------------- | ---------------------------------------------------------- |
| "Acessibilidade é opcional."           | É exigência legal em muitos lugares e padrão de qualidade. |
| "Deixo responsivo depois."             | Adaptar depois é três vezes mais difícil.                  |
| "É só um protótipo."                   | Protótipo vira produção.                                   |
| "A estética de IA serve por enquanto." | Ela passa a impressão de baixa qualidade.                  |

## Sinais de alerta

- Componente com mais de 200 linhas.
- Estilo inline ou valores de pixel aleatórios.
- Faltam os estados de carregando, vazio ou erro.
- Cor como único indicador de estado.
- A tal "cara de IA": gradiente roxo, cards enormes, layout de modelo pronto.

## Antes de concluir

- [ ] A página abre no `view_page` sem erros no console.
- [ ] Todo elemento interativo funciona pelo teclado (Tab na página toda).
- [ ] Funciona em 320px, 768px, 1024px e 1440px.
- [ ] Os estados de carregando, vazio, erro e sucesso estão tratados.
- [ ] Segue o design do projeto: espaçamento, cores, tipografia.
- [ ] Os comandos de teste, tipos e lint do projeto passam; o que não deu para rodar está dito no `finish`.
