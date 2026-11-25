import { zodResolver } from '@hookform/resolvers/zod';
import { isApiError } from '@storeplix/api-client';
import type { CustomerChannel, CustomerDetail } from '@storeplix/types';
import { Dialog, Input, Select, TagInput } from '@storeplix/ui';
import { useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { useInvalidate } from '../catalog/queries';
import { useStoreScope } from '../catalog/scope';
import { errorMessage } from '../catalog/states';
import { api } from '../lib/api';
import { formatBdPhone, normalizeBdPhone } from '../lib/phone';
import { ConflictDialog } from '../online-store/components/Shell';
import { toast } from '../online-store/components/Toast';
import { hasControlChars } from '../products/schema';

// Customers 63:14972 "+ Add customer" dialog / customer detail "Edit" (contract §9.1, §3.5 validation).

export const channelLabels: Record<CustomerChannel, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  whatsapp: 'WhatsApp',
  website: 'Website',
  phone: 'Phone call',
  walk_in: 'Walk-in',
  other: 'Other',
};


export const customerSchema = z
  .object({
    name: z.string().trim().min(1, 'Enter the customer’s name.').max(120, 'Keep the name to 120 characters.').refine((s) => !hasControlChars(s), 'Remove special characters.'),
    phone: z.string().refine((s) => !s.trim() || normalizeBdPhone(s) !== null, 'Enter a Bangladeshi mobile number (01XXXXXXXXX).'),
    email: z.string().trim().max(254).refine((s) => !s || z.email().safeParse(s).success, 'Enter a valid email.'),
    district: z.string().max(80, 'Keep it to 80 characters.'),
    area: z.string().max(120, 'Keep it to 120 characters.'),
    channel: z.string(),
    tags: z.array(z.string()).max(20, 'Up to 20 tags.'),
  })
  .refine((v) => v.phone.trim() || v.email.trim(), { path: ['phone'], message: 'Add a phone number or an email.' });

export type CustomerFormValues = z.infer<typeof customerSchema>;

const toValues = (c?: CustomerDetail | null): CustomerFormValues => ({
  name: c?.name ?? '',
  phone: c?.phone ? formatBdPhone(c.phone) : '',
  email: c?.email ?? '',
  district: c?.district ?? '',
  area: c?.area ?? '',
  channel: c?.channel ?? '',
  tags: c?.tags ?? [],
});

export function toCustomerInput(v: CustomerFormValues) {
  return {
    name: v.name.trim(),
    phone: v.phone.trim() ? normalizeBdPhone(v.phone) : null,
    email: v.email.trim() ? v.email.trim().toLowerCase() : null,
    district: v.district.trim() || null,
    area: v.area.trim() || null,
    channel: (v.channel || null) as CustomerChannel | null,
    tags: v.tags,
  };
}

export function CustomerFormDialog({ open, customer, onClose, onSaved }: { open: boolean; customer?: CustomerDetail | null; onClose: () => void; onSaved?: (c: CustomerDetail) => void }) {
  const { storeId } = useStoreScope();
  const invalidate = useInvalidate();
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const values = useMemo(() => toValues(customer), [customer]);
  const { register, control, handleSubmit, reset, setError, formState } = useForm<CustomerFormValues>({ resolver: zodResolver(customerSchema), values });
  const close = () => {
    reset(values);
    setFormError(null);
    onClose();
  };

  const submit = handleSubmit(async (v) => {
    setFormError(null);
    try {
      const input = toCustomerInput(v);
      const saved = customer ? await api.customers.update(storeId!, customer.id, { ...input, revision: customer.revision }) : await api.customers.create(storeId!, input);
      await invalidate.customers(saved.id);
      toast(customer ? 'Customer saved.' : `Added ${saved.name}.`);
      onSaved?.(saved);
      close();
    } catch (e) {
      if (isApiError(e) && e.code === 'revision_conflict') return setConflict(true);
      if (isApiError(e) && e.isValidation && e.fieldErrors) {
        let mapped = false;
        for (const f of ['name', 'phone', 'email', 'district', 'area', 'channel', 'tags'] as const) {
          const m = e.fieldError(f);
          if (m) {
            setError(f, { type: 'server', message: m });
            mapped = true;
          }
        }
        if (mapped) return;
      }
      setFormError(errorMessage(e, 'Saving failed. Try again.'));
    }
  });

  return (
    <>
      <Dialog open={open} size="md" title={customer ? 'Edit customer' : 'Add customer'} confirmLabel={customer ? 'Save' : 'Add customer'} formId="customer-form" loading={formState.isSubmitting} onCancel={close} onConfirm={() => {}}>
        <form id="customer-form" noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <Input label="Name" autoComplete="off" maxLength={120} error={formState.errors.name?.message} {...register('name')} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Phone" inputMode="tel" placeholder="01XXXXXXXXX" error={formState.errors.phone?.message} {...register('phone')} />
            <Input label="Email" type="email" placeholder="Optional" error={formState.errors.email?.message} {...register('email')} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="District" placeholder="e.g. Dhaka" maxLength={80} error={formState.errors.district?.message} {...register('district')} />
            <Input label="Area" placeholder="e.g. Mirpur" maxLength={120} error={formState.errors.area?.message} {...register('area')} />
          </div>
          <Select label="Came from" {...register('channel')}>
            <option value="">Not set</option>
            {(Object.keys(channelLabels) as CustomerChannel[]).map((c) => (
              <option key={c} value={c}>
                {channelLabels[c]}
              </option>
            ))}
          </Select>
          <Controller control={control} name="tags" render={({ field }) => <TagInput label="Tags" value={field.value} onChange={field.onChange} error={formState.errors.tags?.message} />} />
          {formError && (
            <p role="alert" className="text-caption text-danger">
              {formError}
            </p>
          )}
        </form>
      </Dialog>
      <ConflictDialog
        open={conflict}
        onReload={() => {
          setConflict(false);
          void invalidate.customers(customer?.id);
          close();
        }}
      />
    </>
  );
}
