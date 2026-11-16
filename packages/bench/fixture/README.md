# Loja

Biblioteca de uma pequena loja virtual, em TypeScript, executada direto pelo Node (sem build e sem dependências).

- `src/store.ts`: catálogo de produtos.
- `src/cart.ts`: carrinho, desconto, frete e total.
- `src/money.ts`: valores em centavos e formatação em reais.
- `src/text.ts`: utilidades de texto.
- `src/dates.ts`: datas e dias úteis.
- `src/config.ts`: constantes de negócio.
- `src/index.ts`: reexporta tudo.

Valores em dinheiro são sempre inteiros, em centavos. Imports entre arquivos usam a extensão `.ts`.

## Testes

    npm test
