import { DomainError } from '../common/errors/domain-error';

export interface SelectableItem {
  id: string;
  name: string;
  basePriceMinor: number;
  isAvailable: boolean;
  deletedAt: Date | null;
  stockQuantity: number | null;
  variants: { id: string; name: string; priceMinor: number; isAvailable: boolean }[];
  addonGroups: {
    id: string;
    name: string;
    minSelect: number;
    maxSelect: number;
    addons: { id: string; name: string; priceMinor: number; isAvailable: boolean }[];
  }[];
}

export interface ResolvedSelection {
  unitPriceMinor: number;
  variantId: string | null;
  variantName: string | null;
  addons: { addonId: string; name: string; priceMinor: number }[];
}

const bad = (code: string, message: string, details?: unknown) => new DomainError(code, message, 422, details);

/**
 * Validates a customer's choice (variant + add-ons) against the CURRENT menu and resolves prices from it.
 * Prices always come from here, never from the client.
 */
export function resolveSelection(item: SelectableItem, variantId: string | null | undefined, addonIds: readonly string[]): ResolvedSelection {
  if (item.deletedAt || !item.isAvailable) throw bad('ITEM_UNAVAILABLE', `${item.name} is not available`, { menuItemId: item.id });

  let unitPriceMinor = item.basePriceMinor;
  let variantName: string | null = null;
  if (item.variants.length > 0) {
    if (!variantId) throw bad('VARIANT_REQUIRED', `Choose an option for ${item.name}`, { menuItemId: item.id });
    const v = item.variants.find((x) => x.id === variantId);
    if (!v) throw bad('VARIANT_INVALID', 'Selected option does not belong to this item', { menuItemId: item.id });
    if (!v.isAvailable) throw bad('VARIANT_UNAVAILABLE', `${v.name} is not available`, { menuItemId: item.id, variantId });
    unitPriceMinor = v.priceMinor;
    variantName = v.name;
  } else if (variantId) {
    throw bad('VARIANT_INVALID', 'This item has no options', { menuItemId: item.id });
  }

  if (new Set(addonIds).size !== addonIds.length) throw bad('ADDON_DUPLICATE', 'Each add-on can be selected once');

  const resolved: ResolvedSelection['addons'] = [];
  const perGroup = new Map<string, number>();
  for (const addonId of addonIds) {
    const group = item.addonGroups.find((g) => g.addons.some((a) => a.id === addonId));
    const addon = group?.addons.find((a) => a.id === addonId);
    if (!group || !addon) throw bad('ADDON_INVALID', 'Selected add-on does not belong to this item', { addonId });
    if (!addon.isAvailable) throw bad('ADDON_UNAVAILABLE', `${addon.name} is not available`, { addonId });
    perGroup.set(group.id, (perGroup.get(group.id) ?? 0) + 1);
    resolved.push({ addonId, name: addon.name, priceMinor: addon.priceMinor });
  }
  for (const g of item.addonGroups) {
    const n = perGroup.get(g.id) ?? 0;
    if (n < g.minSelect) throw bad('ADDON_GROUP_MIN', `Choose at least ${g.minSelect} from "${g.name}"`, { groupId: g.id });
    if (n > g.maxSelect) throw bad('ADDON_GROUP_MAX', `Choose at most ${g.maxSelect} from "${g.name}"`, { groupId: g.id });
  }
  return { unitPriceMinor, variantId: variantId ?? null, variantName, addons: resolved };
}

/** Lines that are identical (item, variant, add-ons, notes) are merged instead of duplicated. */
export function lineSignature(menuItemId: string, variantId: string | null | undefined, addonIds: readonly string[], notes: string | null | undefined): string {
  return [menuItemId, variantId ?? '', [...addonIds].sort().join(','), (notes ?? '').trim().toLowerCase()].join('|');
}
