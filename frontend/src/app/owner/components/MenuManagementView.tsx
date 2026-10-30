'use client';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Card, Badge, Skeleton } from '@/components/ui/misc';
import { Input, Label, Textarea } from '@/components/ui/form';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { EmptyState } from '@/components/states';
import { Plus, Trash2, Edit2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import type { OwnerRestaurant, MenuItemData } from '@/lib/types';
import { useOwnerMenu } from '@/hooks/queries';

export function MenuManagementView({ restaurantId }: { restaurantId: string }) {
  const qc = useQueryClient();
  const menuQuery = useOwnerMenu(restaurantId);

  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  const [newCatName, setNewCatName] = useState('');

  const [itemModalOpen, setItemModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<{
    id?: string;
    categoryId: string;
    name: string;
    description: string;
    priceTaka: string;
  } | null>(null);

  const addCategoryMutation = useMutation({
    mutationFn: () => api.post(`/owner/restaurants/${restaurantId}/menu/categories`, { name: newCatName.trim() }),
    onSuccess: () => {
      toast.success('Category created');
      setNewCatName('');
      setCategoryModalOpen(false);
      void qc.invalidateQueries({ queryKey: ['owner-menu', restaurantId] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not create category'),
  });

  const deleteCategoryMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/owner/restaurants/${restaurantId}/menu/categories/${id}`),
    onSuccess: () => {
      toast.success('Category deleted');
      void qc.invalidateQueries({ queryKey: ['owner-menu', restaurantId] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not delete category'),
  });

  const saveItemMutation = useMutation({
    mutationFn: async () => {
      if (!editingItem) return;
      const basePriceMinor = Math.round(parseFloat(editingItem.priceTaka) * 100);
      const payload = {
        name: editingItem.name.trim(),
        description: editingItem.description.trim() || undefined,
        basePriceMinor,
        categoryId: editingItem.categoryId,
      };
      if (editingItem.id) {
        return api.patch(`/owner/restaurants/${restaurantId}/menu/items/${editingItem.id}`, payload);
      }
      return api.post(`/owner/restaurants/${restaurantId}/menu/items`, payload);
    },
    onSuccess: () => {
      toast.success(editingItem?.id ? 'Item updated' : 'Item added to menu');
      setItemModalOpen(false);
      setEditingItem(null);
      void qc.invalidateQueries({ queryKey: ['owner-menu', restaurantId] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save item'),
  });

  const toggleAvailabilityMutation = useMutation({
    mutationFn: ({ id, isAvailable }: { id: string; isAvailable: boolean }) =>
      api.patch(`/owner/restaurants/${restaurantId}/menu/items/${id}/availability`, { isAvailable }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['owner-menu', restaurantId] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not update item availability'),
  });

  const deleteItemMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/owner/restaurants/${restaurantId}/menu/items/${id}`),
    onSuccess: () => {
      toast.success('Item removed');
      void qc.invalidateQueries({ queryKey: ['owner-menu', restaurantId] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not remove item'),
  });

  const categories = menuQuery.data?.categories ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 pb-2 border-b border-border">
        <div>
          <h2 className="font-display text-xl font-bold">Restaurant Menu</h2>
          <p className="text-sm text-muted-foreground">Manage categories, dishes, pricing and stock status.</p>
        </div>
        <Button size="sm" onClick={() => setCategoryModalOpen(true)}>
          <Plus className="h-4 w-4 mr-1" /> New Category
        </Button>
      </div>

      {menuQuery.isLoading ? (
        <Skeleton className="h-48" />
      ) : categories.length === 0 ? (
        <EmptyState title="Your menu is empty">
          Start by creating your first category (e.g. “Main Courses”, “Beverages”, “Desserts”) and adding items.
        </EmptyState>
      ) : (
        <div className="space-y-8">
          {categories.map(cat => (
            <div key={cat.id} className="rounded-card border border-border bg-card p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <h3 className="font-display font-bold text-xl">{cat.name}</h3>
                  <Badge tone="neutral" className="text-xs">{cat.items.length} items</Badge>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => { setEditingItem({ categoryId: cat.id, name: '', description: '', priceTaka: '350' }); setItemModalOpen(true); }} className="text-xs h-8">
                    <Plus className="h-3 w-3 mr-1" /> Add Dish
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { if (confirm(`Delete category "${cat.name}"?`)) deleteCategoryMutation.mutate(cat.id); }} className="text-xs text-destructive h-8 px-2">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              {cat.items.length === 0 ? (
                <p className="text-sm text-muted-foreground italic py-3 text-center border border-dashed border-border rounded-tile">
                  No items in this category yet.
                </p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {cat.items.map((it: MenuItemData) => (
                    <div key={it.id} className="flex items-start justify-between gap-3 rounded-tile border border-border p-3.5 hover:bg-panel/40">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-base">{it.name}</span>
                          <button type="button" onClick={() => toggleAvailabilityMutation.mutate({ id: it.id, isAvailable: !it.isAvailable })}
                            className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${it.isAvailable ? 'bg-success/15 text-success hover:bg-success/25' : 'bg-destructive/15 text-destructive hover:bg-destructive/25'}`}
                          >
                            {it.isAvailable ? 'In Stock' : 'Sold Out'}
                          </button>
                        </div>
                        {it.description && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{it.description}</p>}
                        <p className="text-sm font-semibold mt-1">{formatMoney(it.basePriceMinor)}</p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button variant="ghost" size="sm" onClick={() => { setEditingItem({ id: it.id, categoryId: cat.id, name: it.name, description: it.description ?? '', priceTaka: (it.basePriceMinor / 100).toString() }); setItemModalOpen(true); }} className="h-8 w-8 p-0">
                          <Edit2 className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => { if (confirm(`Remove item "${it.name}"?`)) deleteItemMutation.mutate(it.id); }} className="h-8 w-8 p-0 text-destructive">
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Category Modal */}
      <Dialog open={categoryModalOpen} onOpenChange={setCategoryModalOpen}>
        <DialogContent>
          <DialogTitle>Add menu category</DialogTitle>
          <div className="mt-4 space-y-4">
            <div>
              <Label htmlFor="cat-n">Category name</Label>
              <Input id="cat-n" value={newCatName} onChange={e => setNewCatName(e.target.value)} placeholder="e.g. Starters, Biryani, Curries, Drinks" required />
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <Button variant="outline" onClick={() => setCategoryModalOpen(false)}>Cancel</Button>
              <Button disabled={!newCatName.trim()} onClick={() => addCategoryMutation.mutate()} loading={addCategoryMutation.isPending}>Create Category</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Item Modal */}
      <Dialog open={itemModalOpen} onOpenChange={setItemModalOpen}>
        <DialogContent>
          <DialogTitle>{editingItem?.id ? 'Edit dish' : 'Add new dish'}</DialogTitle>
          {editingItem && (
            <div className="mt-4 space-y-4">
              <div>
                <Label htmlFor="dish-n">Dish name</Label>
                <Input id="dish-n" value={editingItem.name} onChange={e => setEditingItem({ ...editingItem, name: e.target.value })} placeholder="e.g. Kacchi Biryani (Full)" required />
              </div>
              <div>
                <Label htmlFor="dish-p">Base price (৳)</Label>
                <Input id="dish-p" type="number" step="1" value={editingItem.priceTaka} onChange={e => setEditingItem({ ...editingItem, priceTaka: e.target.value })} required />
              </div>
              <div>
                <Label htmlFor="dish-d">Description</Label>
                <Textarea id="dish-d" value={editingItem.description} onChange={e => setEditingItem({ ...editingItem, description: e.target.value })} placeholder="Ingredients, spice level, sides included" rows={3} />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <Button variant="outline" onClick={() => setItemModalOpen(false)}>Cancel</Button>
                <Button disabled={!editingItem.name.trim() || !editingItem.priceTaka} onClick={() => saveItemMutation.mutate()} loading={saveItemMutation.isPending}>Save Dish</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

