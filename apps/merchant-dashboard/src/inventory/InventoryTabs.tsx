import { Tabs } from '@storeplix/ui';
import { useNavigate } from 'react-router';
import { useStoreScope } from '../catalog/scope';
import { useFeatures } from '../plan/useFeatures';
import { multiWarehouseLocked, useStockLocations } from './locations';

// PHASE-8-8B §10: Inventory tabs Stock levels · Stock movements · Purchase orders · Suppliers (Figma 35:5619 tab bar;
// Stock count is hidden until 8.8c part B). Purchase orders shows with `purchasing.manage|inventory.adjust`, Suppliers with
// `purchasing.manage`. PHASE-8-8C §10.2: Warehouses (11:808) shows for every member (reads are base; writes need
// `settings.manage`), also for a one-location store. Each tab is its own route, so Inventory stays the active nav item.
// PHASE-8-8C part B (§10): Transfers (153:34425) shows when the store has > 1 active location or its plan includes
// `multi_warehouse` (a one-location store without it sees no location UI); Stock count (153:35246) shows for everyone.

export type InventoryTab = 'levels' | 'movements' | 'purchase-orders' | 'suppliers' | 'warehouses' | 'transfers' | 'counts';

const paths: Record<InventoryTab, string> = {
  levels: '/inventory',
  movements: '/inventory?tab=movements',
  'purchase-orders': '/inventory/purchase-orders',
  suppliers: '/inventory/suppliers',
  warehouses: '/inventory/warehouses',
  transfers: '/inventory/transfers',
  counts: '/inventory/counts',
};

export function InventoryTabs({ value, onChange }: { value: InventoryTab; onChange?: (t: InventoryTab) => void }) {
  const navigate = useNavigate();
  const scope = useStoreScope();
  const locs = useStockLocations();
  const features = useFeatures().data;
  const showTransfers = locs.multi || (!!features && !multiWarehouseLocked(features));
  const items: { value: InventoryTab; label: string }[] = [
    { value: 'levels', label: 'Stock levels' },
    { value: 'movements', label: 'Stock movements' },
    ...(scope.canReceiveStock ? [{ value: 'purchase-orders' as const, label: 'Purchase orders' }] : []),
    ...(scope.canManagePurchasing ? [{ value: 'suppliers' as const, label: 'Suppliers' }] : []),
    { value: 'warehouses', label: 'Warehouses' },
    ...(showTransfers || value === 'transfers' ? [{ value: 'transfers' as const, label: 'Transfers' }] : []),
    { value: 'counts', label: 'Stock count' },
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
