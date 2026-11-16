export interface Product {
  sku: string;
  name: string;
  priceCents: number;
  category: string;
}

export interface Store {
  products: Product[];
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
