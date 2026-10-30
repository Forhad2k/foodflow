import { lineSignature, resolveSelection, SelectableItem } from './menu-selection';

const item = (o: Partial<SelectableItem> = {}): SelectableItem => ({
  id: 'i1', name: 'Kacchi Biryani', basePriceMinor: 30000, isAvailable: true, deletedAt: null, stockQuantity: null,
  variants: [
    { id: 'v-half', name: 'Half', priceMinor: 30000, isAvailable: true },
    { id: 'v-full', name: 'Full', priceMinor: 55000, isAvailable: true },
    { id: 'v-off', name: 'Family', priceMinor: 99000, isAvailable: false },
  ],
  addonGroups: [
    { id: 'g-side', name: 'Sides', minSelect: 0, maxSelect: 2, addons: [
      { id: 'a-borhani', name: 'Borhani', priceMinor: 4000, isAvailable: true },
      { id: 'a-salad', name: 'Salad', priceMinor: 2000, isAvailable: true },
      { id: 'a-egg', name: 'Egg', priceMinor: 1500, isAvailable: true },
      { id: 'a-gone', name: 'Raita', priceMinor: 1000, isAvailable: false },
    ] },
    { id: 'g-spice', name: 'Spice level', minSelect: 1, maxSelect: 1, addons: [
      { id: 'a-mild', name: 'Mild', priceMinor: 0, isAvailable: true },
      { id: 'a-hot', name: 'Hot', priceMinor: 0, isAvailable: true },
    ] },
  ],
  ...o,
});
const code = (fn: () => unknown) => { try { fn(); return 'OK'; } catch (e: any) { return e.code; } };

describe('resolveSelection', () => {
  it('prices from the server menu: variant price replaces base, add-ons are listed', () => {
    const r = resolveSelection(item(), 'v-full', ['a-borhani', 'a-hot']);
    expect(r.unitPriceMinor).toBe(55000);
    expect(r.variantName).toBe('Full');
    expect(r.addons.map((a) => a.priceMinor)).toEqual([4000, 0]);
  });
  it('requires a variant when the item has variants, and rejects foreign ones', () => {
    expect(code(() => resolveSelection(item(), null, ['a-mild']))).toBe('VARIANT_REQUIRED');
    expect(code(() => resolveSelection(item(), 'v-other', ['a-mild']))).toBe('VARIANT_INVALID');
    expect(code(() => resolveSelection(item(), 'v-off', ['a-mild']))).toBe('VARIANT_UNAVAILABLE');
    expect(code(() => resolveSelection(item({ variants: [] }), 'v-half', ['a-mild']))).toBe('VARIANT_INVALID');
  });
  it('enforces add-on group min/max, availability, ownership and duplicates', () => {
    expect(code(() => resolveSelection(item(), 'v-half', []))).toBe('ADDON_GROUP_MIN'); // spice required
    expect(code(() => resolveSelection(item(), 'v-half', ['a-mild', 'a-hot']))).toBe('ADDON_GROUP_MAX');
    expect(code(() => resolveSelection(item(), 'v-half', ['a-borhani', 'a-salad', 'a-egg', 'a-mild']))).toBe('ADDON_GROUP_MAX');
    expect(code(() => resolveSelection(item(), 'v-half', ['a-gone', 'a-mild']))).toBe('ADDON_UNAVAILABLE');
    expect(code(() => resolveSelection(item(), 'v-half', ['a-from-another-item', 'a-mild']))).toBe('ADDON_INVALID');
    expect(code(() => resolveSelection(item(), 'v-half', ['a-mild', 'a-mild']))).toBe('ADDON_DUPLICATE');
  });
  it('rejects unavailable or deleted items', () => {
    expect(code(() => resolveSelection(item({ isAvailable: false }), 'v-half', ['a-mild']))).toBe('ITEM_UNAVAILABLE');
    expect(code(() => resolveSelection(item({ deletedAt: new Date() }), 'v-half', ['a-mild']))).toBe('ITEM_UNAVAILABLE');
  });
});

describe('lineSignature', () => {
  it('ignores add-on order and note case/whitespace, but not real differences', () => {
    expect(lineSignature('i', 'v', ['b', 'a'], ' No Onion ')).toBe(lineSignature('i', 'v', ['a', 'b'], 'no onion'));
    expect(lineSignature('i', 'v', ['a'], null)).not.toBe(lineSignature('i', 'v2', ['a'], null));
  });
});
