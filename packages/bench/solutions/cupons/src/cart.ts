import { FRETE_GRATIS_ACIMA, FRETE_PADRAO, MAX_ITENS } from './config.ts';
import { percentOf } from './money.ts';

export interface CartItem {
  sku: string;
  name: string;
  priceCents: number;
  quantity: number;
}

export interface Cart {
  items: CartItem[];
  discountPercent: number;
  freeShipping?: boolean;
}

export class CupomInvalidoError extends Error {
  constructor(code: string) {
    super(`Cupom inválido: ${code}`);
    this.name = 'CupomInvalidoError';
  }
}

export function createCart(): Cart {
  return { items: [], discountPercent: 0 };
}

export function itemCount(cart: Cart): number {
  return cart.items.reduce((sum, item) => sum + item.quantity, 0);
}

/** Adds units of an item to the cart (changes the cart it receives). */
export function addItem(cart: Cart, item: CartItem): void {
  if (item.quantity <= 0) throw new Error('Quantidade deve ser positiva.');
  if (itemCount(cart) + item.quantity > MAX_ITENS)
    throw new Error(`O carrinho aceita no máximo ${MAX_ITENS} itens.`);
  const existing = cart.items.find((line) => line.sku === item.sku);
  if (existing) existing.quantity += item.quantity;
  else cart.items.push({ ...item });
}

export function setDiscount(cart: Cart, percent: number): void {
  if (percent < 0 || percent > 100) throw new Error('Desconto inválido.');
  cart.discountPercent = percent;
}

export function applyCoupon(cart: Cart, code: string): void {
  const normalized = code.trim().toUpperCase();
  if (normalized === 'BEMVINDO10') setDiscount(cart, 10);
  else if (normalized === 'FRETEGRATIS') cart.freeShipping = true;
  else throw new CupomInvalidoError(code);
}

export function subtotal(cart: Cart): number {
  return cart.items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
}

export function discount(cart: Cart): number {
  return percentOf(subtotal(cart), cart.discountPercent);
}

export function shipping(cart: Cart): number {
  if (!cart.items.length || cart.freeShipping) return 0;
  return subtotal(cart) >= FRETE_GRATIS_ACIMA ? 0 : FRETE_PADRAO;
}

export function total(cart: Cart): number {
  return subtotal(cart) - discount(cart) + shipping(cart);
}
