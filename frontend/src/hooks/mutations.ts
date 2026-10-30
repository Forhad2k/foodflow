import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Cart } from '@/lib/types';

/** Every cart mutation returns the fresh server-priced cart; we store it instead of re-fetching. */
export function useCartMutations() {
  const qc = useQueryClient();
  const put = (c: Cart) => qc.setQueryData(['cart'], c);
  return {
    add: useMutation({
      mutationFn: (v: { menuItemId: string; variantId?: string; addonIds?: string[]; quantity: number; notes?: string; replaceCart?: boolean }) => api.post<Cart>('/cart/items', v),
      onSuccess: put,
    }),
    update: useMutation({ mutationFn: (v: { id: string; quantity?: number; notes?: string }) => api.patch<Cart>(`/cart/items/${v.id}`, { quantity: v.quantity, notes: v.notes }), onSuccess: put }),
    remove: useMutation({ mutationFn: (id: string) => api.delete<Cart>(`/cart/items/${id}`), onSuccess: put }),
    setCoupon: useMutation({ mutationFn: (code: string) => api.put<Cart>('/cart/coupon', { code }), onSuccess: put }),
    removeCoupon: useMutation({ mutationFn: () => api.delete<Cart>('/cart/coupon'), onSuccess: put }),
  };
}
