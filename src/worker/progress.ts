import type { Quote } from '../lib/domain';

export function priceUpdate(destination: string, kind: 'flights' | 'stays', quote: Quote) {
  const price = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 2 }).format(quote.total);
  const scope = kind === 'flights' ? 'return flights' : 'the whole stay';
  return `${destination}: ${price} for ${scope}, ${quote.travellers} ${quote.travellers === 1 ? 'person' : 'people'}, ${quote.departureDate}–${quote.returnDate}. This is a checked price; room, access and other requirements are still separate checks.`;
}
