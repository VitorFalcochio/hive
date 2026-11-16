export interface Product {
  sku: string;
  name: string;
  priceCents: number;
  category: string;
}

export interface Store {
  products: Product[];
}

export interface SearchOptions {
  category?: string;
  sort?: 'price-asc' | 'price-desc';
}

export function createStore(products: Product[]): Store {
  return { products: products.map((product) => ({ ...product })) };
}

export function getProduct(store: Store, sku: string): Product {
  const product = store.products.find((item) => item.sku === sku);
  if (!product) throw new Error(`Produto nao encontrado: ${sku}`);
  return product;
}

export function listProducts(store: Store): Product[] {
  return [...store.products];
}

export function productsByCategory(store: Store, category: string): Product[] {
  return store.products.filter((product) => product.category === category);
}

const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

export function searchProducts(
  store: Store,
  query: string,
  options: SearchOptions = {},
): Product[] {
  const needle = fold(query.trim());
  const found = store.products.filter(
    (product) =>
      fold(product.name).includes(needle) &&
      (!options.category || product.category === options.category),
  );
  if (options.sort === 'price-asc') found.sort((a, b) => a.priceCents - b.priceCents);
  if (options.sort === 'price-desc') found.sort((a, b) => b.priceCents - a.priceCents);
  return found;
}
