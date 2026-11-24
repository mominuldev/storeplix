import { Tabs } from '@storeplix/ui';
import { useNavigate } from 'react-router';
import { useStoreScope } from '../catalog/scope';

// PHASE-8-8B §10: Inventory tabs Stock levels · Stock movements · Purchase orders · Suppliers (Figma 35:5619 tab bar;
// Stock count is hidden until 8.8c part B). Purchase orders shows with `purchasing.manage|inventory.adjust`, Suppliers with
// `purchasing.manage`. PHASE-8-8C §10.2: Warehouses (11:808) shows for every member (reads are base; writes need
// `settings.manage`), also for a one-location store. Each tab is its own route, so Inventory stays the active nav item.

export type InventoryTab = 'levels' | 'movements' | 'purchase-orders' | 'suppliers' | 'warehouses';

const paths: Record<InventoryTab, string> = {
  levels: '/inventory',
  movements: '/inventory?tab=movements',
  'purchase-orders': '/inventory/purchase-orders',
  suppliers: '/inventory/suppliers',
  warehouses: '/inventory/warehouses',
};

export function InventoryTabs({ value, onChange }: { value: InventoryTab; onChange?: (t: InventoryTab) => void }) {
  const navigate = useNavigate();
  const scope = useStoreScope();
  const items: { value: InventoryTab; label: string }[] = [
    { value: 'levels', label: 'Stock levels' },
    { value: 'movements', label: 'Stock movements' },
    ...(scope.canReceiveStock ? [{ value: 'purchase-orders' as const, label: 'Purchase orders' }] : []),
    ...(scope.canManagePurchasing ? [{ value: 'suppliers' as const, label: 'Suppliers' }] : []),
    { value: 'warehouses', label: 'Warehouses' },
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
