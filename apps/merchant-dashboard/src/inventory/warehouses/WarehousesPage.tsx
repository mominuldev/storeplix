import { zodResolver } from '@hookform/resolvers/zod';
import { isApiError } from '@storeplix/api-client';
import { LOCATION_TYPE_LABELS, LOCATIONS_MAX, type Location, type LocationInUseReason } from '@storeplix/types';
import { Badge, Button, buttonVariants, Checkbox, DataTable, Dialog, EmptyState, Input, Menu, Modal, Select, type DataTableColumn, type MenuEntry } from '@storeplix/ui';
import { Archive, Lock, MoreHorizontal, Pencil, RotateCcw, Star, Warehouse } from 'lucide-react';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { Link, useSearchParams } from 'react-router';
import { useShipping } from '../../commerce/queries';
import { formatBdt, formatCount, plural } from '../../catalog/format';
import { useStoreScope } from '../../catalog/scope';
import { ErrorBlock, LoadingRows, NoResults } from '../../catalog/states';
import { FilterSelect } from '../../catalog/ui';
import { PageHeader } from '../../layout/PageHeader';
import { toast } from '../../online-store/components/Toast';
import { useFeatures } from '../../plan/useFeatures';
import { InventoryTabs } from '../InventoryTabs';
import {
  activeLocations,
  inUseReasons,
  inUseReasonText,
  locationError,
  locationFormSchema,
  locationInputOf,
  locationValuesOf,
  multiWarehouseLocked,
  useLocationMutations,
  useLocations,
  type LocationFormValues,
} from '../locations';

// PHASE-8-8C §10.2 Inventory → Warehouses (tab 11:808; content **composed** — no Figma frame, built from the Suppliers /
// Inventory patterns): table (cards below md) with name + type tag + Default tag "Online orders ship from here",
// address, units on hand, stock value (`costs.view`), variants in stock; "+ Add location" dialog (name, type, address
// or "Use a pickup address", plan note); row menu Edit / Make default / Archive (409 `location_in_use` reasons) /
// Restore. Writes need `settings.manage`; a store without `multi_warehouse` sees an upgrade note and can't add a 2nd.

export default function WarehousesPage() {
  const scope = useStoreScope();
  const [params, setParams] = useSearchParams();
  const archived = params.get('archived') === '1';
  const list = useLocations();
  const locked = multiWarehouseLocked(useFeatures().data);
  const mut = useLocationMutations();
  const canManage = scope.canManageSettings;
  const [editing, setEditing] = useState<Location | 'new' | null>(null);
  const [archiving, setArchiving] = useState<Location | null>(null);
  const [blocked, setBlocked] = useState<{ location: Location; reasons: LocationInUseReason[] } | null>(null);
  const [makingDefault, setMakingDefault] = useState<Location | null>(null);

  const all = list.data ?? [];
  const active = activeLocations(all);
  const archivedRows = all.filter((l) => l.archived_at);
  const rows = archived ? archivedRows : active;
  const atMax = active.length >= LOCATIONS_MAX;
  const canAdd = canManage && !(locked && active.length >= 1) && !atMax;

  const fail = (e: unknown, fallback: string) => {
    const msg = locationError(e, fallback);
    if (msg) toast(msg, 'error');
  };

  const menuFor = (l: Location): MenuEntry[] =>
    l.archived_at
      ? [
          {
            key: 'unarchive',
            label: 'Restore',
            icon: <RotateCcw />,
            onSelect: () => mut.unarchive.mutate(l.id, { onSuccess: () => toast(`${l.name} restored.`), onError: (e) => fail(e, 'We couldn’t restore this location.') }),
          },
        ]
      : [
          { key: 'edit', label: 'Edit', icon: <Pencil />, onSelect: () => setEditing(l) },
          ...(!l.is_default ? [{ key: 'default', label: 'Make default', hint: 'Online orders ship from here', icon: <Star />, onSelect: () => setMakingDefault(l) }] : []),
          ...(!l.is_default ? [{ key: 'archive', label: 'Archive', hint: 'Only when it’s empty', icon: <Archive />, danger: true, onSelect: () => setArchiving(l) }] : []),
        ];

  const columns: DataTableColumn<Location>[] = [
    {
      key: 'location',
      header: 'Location',
      mobileLabel: false,
      cell: (l) => (
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-body font-semibold text-text-primary">{l.name}</span>
            <Badge size="sm">{LOCATION_TYPE_LABELS[l.type]}</Badge>
            {l.is_default && (
              <Badge size="sm" tone="brand">
                Default
              </Badge>
            )}
            {l.archived_at && <Badge size="sm">Archived</Badge>}
          </span>
          <span className="truncate text-caption text-text-muted">
            {[l.is_default ? 'Online orders ship from here' : null, l.address ?? (l.pickup_location ? `Pickup: ${l.pickup_location.name}` : null)].filter(Boolean).join(' · ') || 'No address'}
          </span>
        </span>
      ),
    },
    { key: 'units', header: 'Units on hand', width: 110, align: 'end', cell: (l) => <span className="text-body text-text-primary">{formatCount(l.units_on_hand)}</span> },
    ...(scope.canViewCosts
      ? [{ key: 'value', header: 'Stock value', width: 120, align: 'end' as const, cell: (l: Location) => <span className="text-body text-text-primary">{formatBdt(l.stock_value_amount)}</span> }]
      : []),
    { key: 'variants', header: 'Variants in stock', width: 130, align: 'end', cell: (l) => <span className="text-body text-text-primary">{formatCount(l.variants_count)}</span> },
    ...(canManage
      ? [
          {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            mobileLabel: false as const,
            width: 40,
            align: 'end' as const,
            cell: (l: Location) => <Menu label={`Actions for ${l.name}`} trigger={<MoreHorizontal aria-hidden className="size-4" />} triggerClassName="size-8" entries={menuFor(l)} />,
          },
        ]
      : []),
  ];

  const state = list.isPending ? (
    <LoadingRows label="Loading locations" />
  ) : list.isError ? (
    <ErrorBlock error={list.error} title="We couldn’t load your locations" onRetry={() => void list.refetch()} />
  ) : rows.length === 0 ? (
    <NoResults title={archived ? 'No archived locations' : 'No locations yet'} />
  ) : undefined;

  return (
    <>
      <PageHeader
        title="Warehouses"
        subtitle="Where you keep stock. Online orders ship from your default location."
        actions={canAdd ? <Button onClick={() => setEditing('new')}>+ Add location</Button> : undefined}
      />
      <InventoryTabs value="warehouses" />
      {locked && <WarehousePlanNote canSeePlans={scope.canViewBilling} />}
      <DataTable
        className="min-w-0"
        label="Locations"
        toolbar={
          archivedRows.length > 0 || archived ? (
            <div className="flex flex-wrap items-center gap-2 px-4 py-3.5">
              <FilterSelect label="Show" value={archived ? '1' : ''} onChange={(e) => setParams(e.target.value ? new URLSearchParams({ archived: '1' }) : new URLSearchParams(), { replace: true })}>
                <option value="">Active ({formatCount(active.length)})</option>
                <option value="1">Archived ({formatCount(archivedRows.length)})</option>
              </FilterSelect>
            </div>
          ) : undefined
        }
        columns={columns}
        rows={rows}
        getRowId={(l) => l.id}
        state={state}
      />
      {!archived && list.isSuccess && active.length === 1 && (
        <EmptyState
          icon={<Warehouse />}
          title="No other locations yet"
          description="Add a godown, shop or hub to see how much stock is where. Online orders keep shipping from your default location."
          action={
            canAdd ? (
              <Button size="sm" variant="secondary" onClick={() => setEditing('new')}>
                + Add location
              </Button>
            ) : undefined
          }
        />
      )}
      {!archived && atMax && canManage && <p className="text-caption text-text-muted">You can have up to {plural(LOCATIONS_MAX, 'location')}. Archive one to add another.</p>}

      {editing && <LocationFormDialog location={editing === 'new' ? null : editing} showPlanNote={locked} onClose={() => setEditing(null)} />}

      <Dialog
        open={!!archiving}
        tone="danger"
        title={archiving ? `Archive ${archiving.name}?` : ''}
        description="It disappears from stock lists and pickers. Its stock history stays. You can restore it later."
        confirmLabel="Archive"
        loading={mut.archive.isPending}
        onCancel={() => setArchiving(null)}
        onConfirm={() => {
          const l = archiving!;
          mut.archive.mutate(l.id, {
            onSuccess: () => {
              toast(`${l.name} archived.`);
              setArchiving(null);
            },
            onError: (e) => {
              setArchiving(null);
              const reasons = inUseReasons(e);
              if (reasons) setBlocked({ location: l, reasons });
              else fail(e, 'We couldn’t archive this location.');
            },
          });
        }}
      />

      <Dialog
        open={!!blocked}
        title={blocked ? `${blocked.location.name} can’t be archived yet` : ''}
        description="Sort these out first:"
        confirmLabel="OK"
        cancelLabel={null}
        onCancel={() => setBlocked(null)}
        onConfirm={() => setBlocked(null)}
      >
        <ul aria-label="Why it can’t be archived" className="flex list-disc flex-col gap-1.5 pl-5 text-body text-text-primary">
          {blocked && blocked.reasons.length > 0 ? blocked.reasons.map((r) => <li key={r}>{inUseReasonText[r]}</li>) : <li>This location is still in use.</li>}
        </ul>
      </Dialog>

      <Dialog
        open={!!makingDefault}
        title={makingDefault ? `Ship online orders from ${makingDefault.name}?` : ''}
        description="Your online shop will show and sell this location’s stock straight away. Orders already placed keep shipping from where their stock was held."
        confirmLabel="Make default"
        loading={mut.makeDefault.isPending}
        onCancel={() => setMakingDefault(null)}
        onConfirm={() => {
          const l = makingDefault!;
          mut.makeDefault.mutate(l.id, {
            onSuccess: () => {
              toast(`Online orders now ship from ${l.name}.`);
              setMakingDefault(null);
            },
            onError: (e) => {
              setMakingDefault(null);
              fail(e, 'We couldn’t change the default location.');
            },
          });
        }}
      />
    </>
  );
}

/** Upgrade note (Free / Starter), same shape as the purchasing plan note. */
export function WarehousePlanNote({ canSeePlans }: { canSeePlans: boolean }) {
  return (
    <div role="note" className="flex flex-wrap items-center gap-2.5 rounded-lg bg-brand-50 px-4 py-3">
      <Lock aria-hidden className="size-4 shrink-0 text-brand-600" />
      <p className="min-w-[12rem] flex-1 text-body text-text-primary">More than one location is on Growth. You can still see, adjust and count stock at the locations you have.</p>
      {canSeePlans && (
        <Link to="/settings/plan" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
          See plans
        </Link>
      )}
    </div>
  );
}

/** Add / edit a location (composed): name, type, address or "Use a pickup address" (prefills the address). */
export function LocationFormDialog({ location, showPlanNote, onClose }: { location: Location | null; showPlanNote: boolean; onClose: () => void }) {
  const { create, update } = useLocationMutations();
  const pickups = useShipping().data?.pickup_locations ?? [];
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    control,
    setValue,
    setError: setFieldError,
    formState: { errors },
  } = useForm<LocationFormValues>({ resolver: zodResolver(locationFormSchema), defaultValues: locationValuesOf(location) });
  const usePickup = useWatch({ control, name: 'use_pickup' });
  const pickupId = useWatch({ control, name: 'pickup_location_id' });
  const saving = create.isPending || update.isPending;

  const pickPickup = (id: string) => {
    setValue('pickup_location_id', id, { shouldValidate: !!errors.pickup_location_id });
    const p = pickups.find((x) => x.id === id);
    if (p) setValue('address', [p.address_line, p.thana, p.district].filter(Boolean).join(', ').slice(0, 200));
  };

  const submit = handleSubmit((v) => {
    setError(null);
    const input = locationInputOf(v);
    const opts = {
      onSuccess: (l: Location) => {
        toast(location ? 'Location saved.' : `${l.name} added.`);
        onClose();
      },
      onError: (e: unknown) => {
        if (isApiError(e) && e.code === 'location_name_taken') {
          setFieldError('name', { message: 'You already have a location with this name.' });
          return;
        }
        if (isApiError(e) && e.status === 422) {
          for (const f of ['name', 'type', 'address', 'pickup_location_id'] as const) {
            const m = e.fieldError(f);
            if (m) setFieldError(f, { message: m });
          }
        }
        setError(locationError(e, 'We couldn’t save this location.'));
      },
    };
    if (location) update.mutate({ id: location.id, input }, opts);
    else create.mutate(input, opts);
  });

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={location ? 'Edit location' : 'Add location'}
      description="A godown, shop or hub where you keep stock."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="location-form" loading={saving}>
            {location ? 'Save location' : 'Add location'}
          </Button>
        </>
      }
    >
      <form id="location-form" noValidate className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
        <Input id="location-name" label="Name" placeholder="Dhanmondi shop" maxLength={60} {...register('name')} error={errors.name?.message} />
        <Select id="location-type" label="Type" {...register('type')} error={errors.type?.message}>
          <option value="warehouse">{LOCATION_TYPE_LABELS.warehouse}</option>
          <option value="shop">{LOCATION_TYPE_LABELS.shop}</option>
        </Select>
        {pickups.length > 0 && <Checkbox label="Use a pickup address" {...register('use_pickup')} />}
        {usePickup && pickups.length > 0 && (
          <Select id="location-pickup" label="Pickup address" value={pickupId} onChange={(e) => pickPickup(e.target.value)} error={errors.pickup_location_id?.message}>
            <option value="">Choose a pickup address</option>
            {pickups.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        )}
        <Input id="location-address" label="Address (optional)" placeholder="Road 7, Dhanmondi, Dhaka" maxLength={200} {...register('address')} error={errors.address?.message} />
        {showPlanNote && !location && <p className="text-caption text-text-muted">A second location needs the Growth plan.</p>}
        {error && (
          <p role="alert" className="text-caption text-danger">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
