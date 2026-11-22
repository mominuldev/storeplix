import { isApiError } from '@storeplix/api-client';
import type { AddressInput, Order, ShippingQuote } from '@storeplix/types';
import { Button, Input } from '@storeplix/ui';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { formatBdt } from '../catalog/format';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, StateCard } from '../catalog/states';
import { addressProblems, type AddressErrors } from '../commerce/address';
import { AddressFields } from '../commerce/AddressFields';
import { daysRange } from '../commerce/format';
import { useCommerceInvalidate, useOrder } from '../commerce/queries';
import { api } from '../lib/api';
import { normalizeBdPhone } from '../lib/phone';
import { FormAlert } from '../onboarding/AuthShell';
import { ConflictDialog, LoadingState } from '../online-store/components/Shell';
import { toast } from '../online-store/components/Toast';
import { Card } from './OrderDetailPage';

// Figma Edit order 144:46654, limited by P5-20 to contact, address and customer note. "Why the change?" is saved as
// a team note. "Edit items" and "Send updated total by SMS" are 5b. A changed address doesn't re-price; the
// response's `meta.shipping_hint` is shown so the merchant knows.

export function OrderEditPage() {
  const { orderId } = useParams();
  const query = useOrder(orderId);
  // Kept above the form: saving bumps `revision`, which remounts the form (key) — the hint must survive that.
  const [hint, setHint] = useState<ShippingQuote | null>(null);
  if (query.isPending) return <LoadingState label="Loading order" />;
  if (query.isError)
    return (
      <StateCard>
        <ErrorBlock error={query.error} onRetry={() => void query.refetch()} />
      </StateCard>
    );
  if (!query.data.can.edit)
    return (
      <StateCard>
        <ErrorBlock title="This order can’t be edited" message="Orders can be edited until they are shipped." />
        <p className="pb-8 text-center">
          <Link to={`/orders/${query.data.id}`} className="font-semibold text-brand-600">
            Back to {query.data.number}
          </Link>
        </p>
      </StateCard>
    );
  return <EditForm key={query.data.revision} order={query.data} hint={hint} setHint={setHint} />;
}

function EditForm({ order, hint, setHint }: { order: Order; hint: ShippingQuote | null; setHint: (h: ShippingQuote | null) => void }) {
  const navigate = useNavigate();
  const { storeId } = useStoreScope();
  const invalidate = useCommerceInvalidate();
  const [name, setName] = useState(order.contact.name);
  const [phone, setPhone] = useState(order.contact.phone.startsWith('880') ? order.contact.phone.slice(2) : order.contact.phone);
  const [email, setEmail] = useState(order.contact.email ?? '');
  const a = order.shipping_address;
  const [address, setAddress] = useState<AddressInput>({ district_code: a.district_code, thana_code: a.thana_code, address_line: a.address_line, area: a.area, landmark: a.landmark, label: a.label });
  const [customerNote, setCustomerNote] = useState(order.customer_note ?? '');
  const [why, setWhy] = useState('');
  const [errors, setErrors] = useState<AddressErrors & Record<string, string | undefined>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const addressChanged =
    address.district_code !== a.district_code || address.thana_code !== a.thana_code || address.address_line !== a.address_line || (address.area ?? null) !== (a.area ?? null) || (address.landmark ?? null) !== (a.landmark ?? null);

  const save = useMutation({
    mutationFn: async () => {
      const res = await api.orders.update(storeId!, order.id, {
        revision: order.revision,
        contact: { name: name.trim(), phone: normalizeBdPhone(phone) ?? phone, email: email.trim() || null },
        ...(addressChanged ? { shipping_address: address } : {}),
        customer_note: customerNote.trim() || null,
      });
      if (why.trim()) await api.orders.addNote(storeId!, order.id, `Edited: ${why.trim()}`);
      return res;
    },
    onSuccess: async ({ shippingHint }) => {
      await invalidate.afterOrderChange(order.id, order.customer.id);
      if (addressChanged && shippingHint && shippingHint.amount !== order.shipping_amount) {
        setHint({ ...shippingHint });
        window.scrollTo?.({ top: 0 });
        return;
      }
      toast('Order updated.');
      navigate(`/orders/${order.id}`);
    },
    onError: (e) => {
      if (isApiError(e) && e.code === 'revision_conflict') return setConflict(true);
      if (isApiError(e) && e.status === 422 && e.details) {
        const next: Record<string, string> = {};
        for (const [k, m] of Object.entries(e.details)) next[k.replace(/^contact\./, '').replace(/^shipping_address\./, '')] = m[0] ?? '';
        setErrors(next);
        return setFormError('Some fields need attention.');
      }
      setFormError(isApiError(e) ? e.message : 'We couldn’t save your changes.');
    },
  });

  const submit = () => {
    const next: Record<string, string | undefined> = { ...addressProblems(address) };
    if (name.trim().length < 2) next.name = 'Enter the customer’s name.';
    if (!normalizeBdPhone(phone)) next.phone = 'Enter a Bangladeshi mobile number (01XXXXXXXXX).';
    const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v));
    setErrors(clean);
    if (Object.keys(clean).length) return setFormError('Some fields need attention.');
    setFormError(null);
    save.mutate();
  };

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <nav aria-label="Breadcrumb" className="text-caption text-text-secondary">
          <Link to="/orders" className="text-brand-600">
            Orders
          </Link>{' '}
          ›{' '}
          <Link to={`/orders/${order.id}`} className="text-brand-600">
            {order.number}
          </Link>{' '}
          › Edit
        </nav>
        <h1 className="text-heading-24 text-text-primary">Edit {order.number}</h1>
        <p className="text-body text-text-secondary">Change the contact or delivery address. Items and prices stay as ordered.</p>
      </div>
      {formError && <FormAlert>{formError}</FormAlert>}
      {hint && (
        <div role="status" className="flex flex-col gap-2 rounded-card border border-warning bg-warning-bg p-4 text-body text-text-primary">
          <p>
            Saved. The new address is in <strong>{hint.zone_name}</strong> ({daysRange(hint.min_days, hint.max_days)}), where delivery is {hint.is_free ? 'free' : formatBdt(hint.amount)}. This order keeps its
            delivery charge of {formatBdt(order.shipping_amount)}.
          </p>
          <Button size="sm" className="self-start" onClick={() => navigate(`/orders/${order.id}`)}>
            Back to order
          </Button>
        </div>
      )}
      <div className="flex max-w-3xl flex-col gap-5">
        <Card title="Contact">
          <div className="grid gap-4 sm:grid-cols-2">
            <Input id="edit-name" label="Name" value={name} maxLength={120} error={errors.name} onChange={(e) => setName(e.target.value)} />
            <Input id="edit-phone" label="Phone" inputMode="tel" value={phone} error={errors.phone} onChange={(e) => setPhone(e.target.value)} />
            <Input id="edit-email" label="Email (optional)" type="email" value={email} maxLength={254} error={errors.email} containerClassName="sm:col-span-2" onChange={(e) => setEmail(e.target.value)} />
          </div>
        </Card>
        <Card title="Delivery address">
          <AddressFields value={address} onChange={setAddress} errors={errors} idPrefix="edit" />
        </Card>
        <Card title="Notes">
          <Input id="edit-customer-note" label="Customer’s note" value={customerNote} maxLength={500} onChange={(e) => setCustomerNote(e.target.value)} />
          <Input id="edit-why" label="Why the change? (saved for your team)" placeholder="Customer called to change the flat number" value={why} maxLength={900} onChange={(e) => setWhy(e.target.value)} />
        </Card>
        <div className="flex justify-end gap-2">
          <Link to={`/orders/${order.id}`} className="inline-flex h-10 items-center px-4 text-body font-medium text-text-secondary">
            Cancel
          </Link>
          <Button loading={save.isPending} onClick={submit}>
            Save changes
          </Button>
        </div>
      </div>
      <ConflictDialog
        open={conflict}
        onReload={() => {
          setConflict(false);
          void invalidate.afterOrderChange(order.id);
        }}
      />
    </>
  );
}

export default OrderEditPage;
