/**
 * The Hive Bench tasks. Each one starts from a fresh copy of `fixture/` and is graded by a hidden
 * check (`checks/<id>.check.ts`) the agent never sees, plus the fixture's own tests (no
 * regressions). `solutions/<id>/` holds a reference solution that proves the check is passable.
 *
 * Levels: 1 a trivial edit · 2 a bug fix · 3 a small feature in one or two files · 4 a feature
 * across several files.
 */
export interface BenchTask {
  id: string;
  level: 1 | 2 | 3 | 4;
  title: string;
  description: string;
  acceptanceCriteria: string[];
}

export const benchTasks: BenchTask[] = [
  {
    id: 'corrigir-mensagem',
    level: 1,
    title: 'Corrigir acentuação da mensagem de produto não encontrado',
    description:
      'A mensagem de erro de getProduct (src/store.ts) diz "Produto nao encontrado". Corrija para "Produto não encontrado", mantendo o SKU no fim como hoje.',
    acceptanceCriteria: ['A mensagem fica "Produto não encontrado: <sku>".', 'npm test passa.'],
  },
  {
    id: 'renomear-constante',
    level: 1,
    title: 'Renomear MAX_ITENS para MAX_ITEMS',
    description:
      'Renomeie a constante MAX_ITENS para MAX_ITEMS em todo o projeto. O valor e o comportamento não mudam.',
    acceptanceCriteria: [
      'Nenhum arquivo cita mais MAX_ITENS.',
      'MAX_ITEMS é exportada de src/config.ts com o mesmo valor.',
      'npm test passa.',
    ],
  },
  {
    id: 'frete-gratis',
    level: 1,
    title: 'Frete grátis a partir de R$ 200,00',
    description:
      'O frete grátis agora vale para compras a partir de R$ 200,00 (antes era a partir de R$ 150,00).',
    acceptanceCriteria: [
      'Subtotal de R$ 200,00 ou mais tem frete zero; abaixo disso, frete padrão.',
      'npm test passa.',
    ],
  },
  {
    id: 'slug-acentos',
    level: 2,
    title: 'slugify perde letras acentuadas',
    description:
      'slugify("Ação Rápida") devolve "a-o-r-pida", mas deveria devolver "acao-rapida": letras acentuadas e "ç" devem virar a letra sem acento, em vez de sumir.',
    acceptanceCriteria: [
      'slugify("Ação Rápida") === "acao-rapida".',
      'Os casos que já funcionavam continuam iguais.',
      'npm test passa.',
    ],
  },
  {
    id: 'dias-uteis',
    level: 2,
    title: 'addBusinessDays conta sábado como dia útil',
    description:
      'addBusinessDays (src/dates.ts) está contando sábado como dia útil. Dias úteis são de segunda a sexta.',
    acceptanceCriteria: [
      'Sexta + 1 dia útil = segunda.',
      'Somar 0 dias devolve a mesma data.',
      'npm test passa.',
    ],
  },
  {
    id: 'desconto-centavos',
    level: 2,
    title: 'Desconto gera centavos quebrados',
    description:
      'Com desconto percentual, o total do carrinho às vezes sai com centavos quebrados: 15% de R$ 19,99 dá 299.85 centavos. Valores em centavos devem ser sempre inteiros. Arredonde para o centavo mais próximo (meio centavo arredonda para cima).',
    acceptanceCriteria: [
      'percentOf(1999, 15) === 300.',
      'discount e total do carrinho são sempre inteiros.',
      'npm test passa.',
    ],
  },
  {
    id: 'remover-item',
    level: 3,
    title: 'Remover unidades de um item do carrinho',
    description:
      'Adicione removeItem(cart, sku, quantity) em src/cart.ts. Ela diminui a quantidade daquele item no carrinho recebido (altera o carrinho, como addItem). Se a quantidade chegar a zero ou menos, a linha sai do carrinho. Se o SKU não estiver no carrinho, lança um Error.',
    acceptanceCriteria: [
      'removeItem existe e está disponível também por src/index.ts.',
      'Remove a linha ao zerar; lança erro para SKU ausente.',
      'npm test passa.',
    ],
  },
  {
    id: 'cupons',
    level: 3,
    title: 'Cupons de desconto',
    description:
      'Adicione applyCoupon(cart, code) em src/cart.ts, que altera o carrinho recebido. Cupons: "BEMVINDO10" dá 10% de desconto; "FRETEGRATIS" zera o frete, qualquer que seja o valor da compra. O código vale com qualquer combinação de maiúsculas e minúsculas. Um código inválido lança CupomInvalidoError, uma classe de erro exportada (subclasse de Error).',
    acceptanceCriteria: [
      'applyCoupon e CupomInvalidoError disponíveis também por src/index.ts.',
      'discount(cart) e shipping(cart) refletem o cupom.',
      'npm test passa.',
    ],
  },
  {
    id: 'truncar-palavras',
    level: 3,
    title: 'Truncar texto sem cortar palavras',
    description:
      'Adicione truncateWords(text, maxLength) em src/text.ts. Se o texto couber em maxLength caracteres, devolve igual. Senão, corta no fim da última palavra que cabe e termina com "…" (um único caractere). O resultado, já com o "…", nunca passa de maxLength. Se nem a primeira palavra couber, corta a palavra e termina com "…".',
    acceptanceCriteria: [
      'truncateWords("Caneca de porcelana azul", 15) === "Caneca de…".',
      'Disponível também por src/index.ts.',
      'npm test passa.',
    ],
  },
  {
    id: 'busca-produtos',
    level: 4,
    title: 'Busca de produtos',
    description:
      'Adicione searchProducts(store, query, options?) em src/store.ts. Busca produtos cujo nome contém a query, sem diferenciar maiúsculas nem acentos ("cafe" acha "Café Especial", "CANECA" acha "caneca"). options.category filtra por categoria. options.sort pode ser "price-asc" ou "price-desc"; sem sort, mantém a ordem do catálogo. Query vazia devolve todos os produtos, respeitando os filtros.',
    acceptanceCriteria: [
      'searchProducts disponível também por src/index.ts.',
      'Busca sem acentos e sem caixa; filtros e ordenação funcionam.',
      'npm test passa.',
    ],
  },
  {
    id: 'estoque',
    level: 4,
    title: 'Estoque dos produtos',
    description:
      'Produtos passam a ter estoque: adicione o campo opcional stock em Product (sem stock = estoque ilimitado). Adicione addProductToCart(cart, store, sku, quantity) em src/cart.ts: pega nome e preço do produto na loja e adiciona ao carrinho, lançando um Error se a quantidade total daquele SKU no carrinho passar do estoque. As regras de addItem (como o limite de itens) continuam valendo.',
    acceptanceCriteria: [
      'addProductToCart disponível também por src/index.ts.',
      'Respeita o estoque somando o que já está no carrinho.',
      'npm test passa.',
    ],
  },
  {
    id: 'exportar-csv',
    level: 4,
    title: 'Exportar e importar produtos em CSV',
    description:
      'Crie src/csv.ts com toCsv(products) e fromCsv(text). A primeira linha é o cabeçalho sku,name,priceCents,category. Campos com vírgula, aspas ou quebra de linha vão entre aspas, e aspas internas são duplicadas. fromCsv(toCsv(lista)) devolve uma lista igual à original, com priceCents como número.',
    acceptanceCriteria: [
      'toCsv e fromCsv disponíveis também por src/index.ts.',
      'Ida e volta preservam os produtos, inclusive com vírgulas, aspas e quebras de linha.',
      'npm test passa.',
    ],
  },
];
