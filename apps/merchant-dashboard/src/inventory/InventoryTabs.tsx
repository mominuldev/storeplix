import { Tabs } from '@storeplix/ui';
import { useNavigate } from 'react-router';
import { useStoreScope } from '../catalog/scope';

// PHASE-8-8B §10: Inventory tabs Stock levels · Stock movements · Purchase orders · Suppliers (Figma 35:5619 tab bar;
// Warehouses and Stock count are hidden until 8.8c+). Purchase orders shows with `purchasing.manage|inventory.adjust`,
// Suppliers with `purchasing.manage`. Each tab is its own route, so Inventory stays the active nav item.

export type InventoryTab = 'levels' | 'movements' | 'purchase-orders' | 'suppliers';

const paths: Record<InventoryTab, string> = {
  levels: '/inventory',
  movements: '/inventory?tab=movements',
  'purchase-orders': '/inventory/purchase-orders',
  suppliers: '/inventory/suppliers',
};

export function InventoryTabs({ value, onChange }: { value: InventoryTab; onChange?: (t: InventoryTab) => void }) {
  const navigate = useNavigate();
  const scope = useStoreScope();
  const items: { value: InventoryTab; label: string }[] = [
    { value: 'levels', label: 'Stock levels' },
    { value: 'movements', label: 'Stock movements' },
    ...(scope.canReceiveStock ? [{ value: 'purchase-orders' as const, label: 'Purchase orders' }] : []),
    ...(scope.canManagePurchasing ? [{ value: 'suppliers' as const, label: 'Suppliers' }] : []),
  ];
  return (
    <Tabs
      aria-label="Inventory"
      value={value}
      onChange={(t) => {
        if (onChange && (t === 'levels' || t === 'movements')) onChange(t);
        else navigate(paths[t]);
      }}
      items={items}
    />
  );
}
