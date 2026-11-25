import { zodResolver } from '@hookform/resolvers/zod';
import { POS_REGISTER_NAME_MAX, POS_REGISTERS_MAX, type PosRegister } from '@storeplix/types';
import { Badge, Button, cn, EmptyState, formatBdt, Input, Modal, parseMoney, Select } from '@storeplix/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Monitor, Plus } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router';
import { z } from 'zod';
import { useAuth } from '../auth/AuthProvider';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, errorMessage, LoadingRows } from '../catalog/states';
import { newIdempotencyKey } from '../commerce/format';
import { useStockLocations } from '../inventory/locations';
import { api } from '../lib/api';
import { toast } from '../online-store/components/Toast';
import { handlePlanLimit } from '../plan/Banners';
import { useFeatures } from '../plan/useFeatures';
import { DenominationTable, PosBar, PosPlanNote, Row, SideCard } from './components';
import { alreadyOpenSession } from './errors';
import { countsSum, createAttemptKeys, dayMonth, denominationsFor, openingHint, posLocked, rememberedRegister, rememberRegister, textsToCounts, timeOf } from './pos';
import { posKeys, useCreateRegister, usePosRegisters } from './queries';

// PHASE-8-8D §11.1 Open register 25:581 (section 27:1025): register select (+ "Add register", composed, settings.manage),
// Cashier = the signed-in member (read-only, Q238), denomination table, opening total with the last-closing hint, side
// cards Registers + Last session. No registers → "Create Register 1 at {default location}" (148:34032 empty pattern).
// Without plan `pos` (§2.2): plan note; open sessions can still be closed (P88D-19).

export default function PosPage() {
  const scope = useStoreScope();
  const registers = usePosRegisters();
  const locked = posLocked(useFeatures().data);

  if (registers.isPending) {
    return (
      <PosFrame subtitle="Loading registers…">
        <LoadingRows rows={6} label="Loading registers" />
      </PosFrame>
    );
  }
  if (registers.isError) {
    return (
      <PosFrame subtitle="Registers">
        <ErrorBlock error={registers.error} title="We couldn’t load your registers" onRetry={() => registers.refetch()} />
      </PosFrame>
    );
  }
  const list = registers.data;
  if (locked) return <LockedPos registers={list} canSeePlans={scope.canViewBilling} />;
  if (list.length === 0) return <NoRegisters canManage={scope.canManageSettings} />;
  return <OpenRegister registers={list} />;
}

/** POS page frame: POS bar + padded body (the app shell gives POS the full content area). */
function PosFrame({ subtitle, actions, children }: { subtitle: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <PosBar subtitle={subtitle}>{actions}</PosBar>
      <div className="flex flex-1 flex-col gap-5 px-4 pt-5 pb-28 lg:px-6 lg:py-6">{children}</div>
    </div>
  );
}

function LockedPos({ registers, canSeePlans }: { registers: PosRegister[]; canSeePlans: boolean }) {
  const navigate = useNavigate();
  const open = registers.filter((r) => r.open_session);
  return (
    <PosFrame subtitle="Not on your plan">
      <PosPlanNote canSeePlans={canSeePlans} />
      {open.length > 0 && (
        <SideCard title="Registers still open" className="max-w-xl">
          <p className="text-body text-text-secondary">Close these registers to count the drawer. Selling needs the Growth plan.</p>
          {open.map((r) => (
            <div key={r.id} className="flex items-center gap-3">
              <span className="flex-1 text-body text-text-primary">
                {r.name} · {r.location.name}
              </span>
              <Button size="sm" variant="secondary" onClick={() => navigate(`/pos/${r.open_session!.id}/close`)}>
                Close register
              </Button>
            </div>
          ))}
        </SideCard>
      )}
    </PosFrame>
  );
}

function NoRegisters({ canManage }: { canManage: boolean }) {
  const { defaultLocation, query } = useStockLocations();
  const create = useCreateRegister();
  return (
    <PosFrame subtitle="No registers yet">
      <section className="rounded-card border border-border-default bg-surface-card shadow-elevation-1" data-testid="pos-no-registers">
        <EmptyState
          icon={<Monitor />}
          title="Set up your first register"
          description={canManage ? 'A register is a till at one of your shops. Sales take stock from its location.' : 'Ask your shop owner or a manager to add a register.'}
          action={
            canManage && (
              <Button
                disabled={!defaultLocation || create.isPending}
                onClick={() =>
                  defaultLocation &&
                  create.mutate(
                    { name: 'Register 1', location_id: defaultLocation.id },
                    {
                      onError: (e) => handlePlanLimit(e) || toast(errorMessage(e, 'We couldn’t create the register.'), 'error'),
                    },
                  )
                }
              >
                {query.isPending ? 'Loading locations…' : `Create Register 1 at ${defaultLocation?.name ?? 'your shop'}`}
              </Button>
            )
          }
        />
      </section>
    </PosFrame>
  );
}

function registerStatus(r: PosRegister): { text: string; open: boolean } {
  if (!r.open_session) return { text: 'Closed · ready', open: false };
  return {
    text: `Open · ${r.open_session.opened_by.name} · since ${timeOf(r.open_session.opened_at)}`,
    open: true,
  };
}

function OpenRegister({ registers }: { registers: PosRegister[] }) {
  const scope = useStoreScope();
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const currency = scope.store?.currency ?? 'BDT';
  const bdt = denominationsFor(currency) !== null;

  const initial = useMemo(() => {
    const remembered = rememberedRegister(scope.storeId);
    return registers.find((r) => r.id === remembered && !r.open_session) ?? registers.find((r) => !r.open_session) ?? registers[0]!;
  }, [registers, scope.storeId]);
  const [registerId, setRegisterId] = useState(initial.id);
  const register = registers.find((r) => r.id === registerId) ?? initial;
  const last = register.last_session;

  const [texts, setTexts] = useState<Record<string, string>>(() => prefillTexts(last?.left_in_drawer_amount ?? null, bdt));
  const [amountText, setAmountText] = useState(() => (last ? String(last.left_in_drawer_amount / 100) : ''));
  const [adding, setAdding] = useState(false);
  const keys = useRef(createAttemptKeys(newIdempotencyKey));

  const counts = bdt ? textsToCounts(currency, texts) : null;
  const amount = bdt ? countsSum(counts) : parseMoney(amountText);
  const invalid = bdt ? counts === null : amount === null || Number.isNaN(amount);
  const hint = openingHint(amount ?? 0, last?.left_in_drawer_amount, last?.closed_at);

  const pick = (r: PosRegister) => {
    rememberRegister(scope.storeId, r.id);
    if (r.open_session) return navigate(`/pos/${r.open_session.id}`);
    setRegisterId(r.id);
    setTexts(prefillTexts(r.last_session?.left_in_drawer_amount ?? null, bdt));
    setAmountText(r.last_session ? String(r.last_session.left_in_drawer_amount / 100) : '');
  };

  const open = useMutation({
    mutationFn: () => {
      const input = bdt ? { counts: counts ?? {} } : { opening_cash_amount: amount ?? 0 };
      return api.pos.registers.open(scope.storeId!, register.id, input, keys.current.keyFor(JSON.stringify([register.id, input])));
    },
    onSuccess: (session) => {
      keys.current.reset();
      rememberRegister(scope.storeId, register.id);
      qc.setQueryData(posKeys.session(scope, session.id), session);
      void qc.invalidateQueries({ queryKey: posKeys.registers(scope) });
      navigate(`/pos/${session.id}`);
    },
    onError: (e) => {
      const joined = alreadyOpenSession(e);
      if (joined) {
        keys.current.reset();
        toast(`${register.name} is already open — joining it.`, 'success');
        return navigate(`/pos/${joined}`);
      }
      if (handlePlanLimit(e)) return;
      toast(errorMessage(e, 'We couldn’t open the register.'), 'error');
    },
  });

  const status = registerStatus(register);
  return (
    <PosFrame subtitle={`${register.name} · ${register.location.name} · ${status.open ? 'Open' : 'Closed'}`}>
      <div className="mx-auto flex w-full max-w-[952px] flex-col gap-5 lg:flex-row lg:items-start">
        <section
          className="flex min-w-0 flex-1 flex-col gap-5 rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1 lg:p-6"
          aria-labelledby="pos-open-title"
        >
          <div className="flex items-center gap-3">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
              <Monitor aria-hidden className="size-6" />
            </span>
            <div className="flex flex-col gap-0.5">
              <h2 id="pos-open-title" className="text-heading-24 text-text-primary">
                Open register
              </h2>
              <p className="text-body text-text-secondary">Count the cash in the drawer before the first sale</p>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Select label="Register" value={register.id} onChange={(e) => pick(registers.find((r) => r.id === e.target.value)!)} data-testid="pos-register-select">
                {registers.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} · {r.location.name}
                    {r.open_session ? ' (open)' : ''}
                  </option>
                ))}
              </Select>
              {scope.canManageSettings && registers.length < POS_REGISTERS_MAX && (
                <button type="button" className="flex items-center gap-1 self-start text-caption font-medium text-brand-600 hover:underline" onClick={() => setAdding(true)}>
                  <Plus aria-hidden className="size-3.5" /> Add register
                </button>
              )}
            </div>
            {/* Q238: the cashier is the signed-in member, read-only (no user switching). */}
            <Input label="Cashier" value={user?.name ?? ''} readOnly aria-readonly data-testid="pos-cashier" />
          </div>

          {bdt ? (
            <DenominationTable currency={currency} texts={texts} onChange={setTexts} />
          ) : (
            <Input
              label="Opening cash"
              inputMode="decimal"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              error={invalid ? 'Enter an amount like 2000 or 2000.50' : undefined}
            />
          )}

          <div className="flex items-center gap-3 rounded-lg bg-brand-50 px-4 py-3">
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-body font-medium text-brand-700">Opening cash</span>
              {hint && <span className={cn('text-caption', hint.tone === 'warning' ? 'text-warning' : 'text-text-secondary')}>{hint.text}</span>}
            </div>
            <span className="text-heading-24 text-brand-700" data-testid="pos-opening-total">
              {formatBdt(invalid ? 0 : amount ?? 0)}
            </span>
          </div>
          <Button size="md" className="min-h-12 text-body-lg" disabled={invalid || open.isPending} onClick={() => open.mutate()} data-testid="pos-open-submit">
            {open.isPending ? 'Opening…' : 'Open register and start selling'}
          </Button>
        </section>

        <aside className="flex w-full flex-col gap-5 lg:w-[330px]">
          <SideCard title="Registers">
            <ul className="flex flex-col gap-3" data-testid="pos-register-list">
              {registers.map((r) => {
                const st = registerStatus(r);
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => pick(r)}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-md text-left outline-none focus-visible:shadow-focus',
                        r.id === register.id && !st.open && 'font-semibold',
                      )}
                    >
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-body text-text-primary">
                          {r.name} · {r.location.name}
                        </span>
                        <span className="truncate text-caption text-text-secondary">{st.text}</span>
                      </span>
                      <Badge size="sm" tone={st.open ? 'success' : 'neutral'}>
                        {st.open ? 'Open' : 'Closed'}
                      </Badge>
                    </button>
                  </li>
                );
              })}
            </ul>
          </SideCard>
          {last && (
            <SideCard title={`Last session · ${dayMonth(last.closed_at)}`}>
              <div className="flex flex-col gap-2" data-testid="pos-last-session">
                <Row label="Sales" value={`${formatBdt(last.sales_amount)} · ${last.receipts_count} receipts`} />
                <Row label="Counted at close" value={formatBdt(last.counted_cash_amount)} />
                <Row label="Variance" value={formatBdt(last.variance_amount)} tone={last.variance_amount < 0 ? 'danger' : undefined} />
                <Row label="Banked" value={formatBdt(last.banked_amount)} />
                <Row label="Left in drawer" value={formatBdt(last.left_in_drawer_amount)} />
              </div>
            </SideCard>
          )}
        </aside>
      </div>
      <AddRegisterDialog open={adding} onClose={() => setAdding(false)} onCreated={(r) => pick(r)} />
    </PosFrame>
  );
}

/** Opening counts prefilled from the last "left in drawer" (P88D-15), greedy over the BDT list. */
function prefillTexts(left: number | null, bdt: boolean): Record<string, string> {
  if (!bdt || !left) return {};
  const out: Record<string, string> = {};
  let rest = left;
  for (const r of denominationsFor('BDT')!) {
    const n = Math.floor(rest / r.value);
    if (n > 0) {
      out[String(r.value)] = String(n);
      rest -= n * r.value;
    }
  }
  return out;
}

const registerSchema = z.object({
  name: z.string().trim().min(1, 'Name the register').max(POS_REGISTER_NAME_MAX, `Up to ${POS_REGISTER_NAME_MAX} characters`),
  location_id: z.string().min(1, 'Pick a location'),
});
type RegisterValues = z.infer<typeof registerSchema>;

/** "+ Add register" (composed): name + location (any active location, shops first). `settings.manage`, plan `pos`. */
function AddRegisterDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (r: PosRegister) => void }) {
  const { active, defaultLocation } = useStockLocations();
  const create = useCreateRegister();
  const locations = [...active].sort((a, b) => Number(b.type === 'shop') - Number(a.type === 'shop'));
  const { register, handleSubmit, setError, reset, formState } = useForm<RegisterValues>({
    resolver: zodResolver(registerSchema),
    values: {
      name: '',
      location_id: (locations.find((l) => l.type === 'shop') ?? defaultLocation)?.id ?? '',
    },
  });
  const close = () => {
    reset();
    onClose();
  };
  const submit = handleSubmit((values) =>
    create.mutate(values, {
      onSuccess: (r) => {
        toast(`${r.name} added.`);
        close();
        onCreated(r);
      },
      onError: (e) => {
        if (handlePlanLimit(e)) return;
        const message = errorMessage(e, 'We couldn’t add the register.');
        if (message && /name/i.test(message)) setError('name', { message });
        else toast(message, 'error');
      },
    }),
  );
  return (
    <Modal
      open={open}
      onClose={close}
      title="Add register"
      description="A till at one of your locations. Its sales take stock from there."
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={create.isPending}>
            {create.isPending ? 'Adding…' : 'Add register'}
          </Button>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
        <Input label="Name" placeholder="Register 2" maxLength={POS_REGISTER_NAME_MAX} error={formState.errors.name?.message} {...register('name')} />
        <Select label="Location" error={formState.errors.location_id?.message} {...register('location_id')}>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
      </form>
    </Modal>
  );
}
