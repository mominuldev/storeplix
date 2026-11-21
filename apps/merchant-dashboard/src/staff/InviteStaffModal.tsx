import { zodResolver } from '@hookform/resolvers/zod';
import { isApiError } from '@storeplix/api-client';
import type { StaffSeatsMeta } from '@storeplix/types';
import { Button, cn, Input, Modal } from '@storeplix/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { inviteSchema, type InviteValues } from '../auth/schemas';
import { api } from '../lib/api';
import { FormAlert } from '../onboarding/AuthShell';

const roleOptions = [
  { value: 'admin' as const, title: 'Manager', detail: 'Everything except billing and ownership', tag: 'Full access' },
  { value: 'staff' as const, title: 'Staff', detail: 'Products, orders & customers · no settings or staff', tag: 'Most common' },
];

// Figma Invite modal 90:26879 — w 600; Full name + Email (Figma: phone → email, SMS not used for invites);
// role radio cards (Owner never assignable; Order staff/Packer and per-person permissions are Phase 8);
// seat note; footer Cancel / Send invite.
export function InviteStaffModal({ open, onClose, seats }: { open: boolean; onClose: () => void; seats?: StaffSeatsMeta }) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    control,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<InviteValues>({ resolver: zodResolver(inviteSchema), defaultValues: { name: '', email: '', role: 'staff' } });

  const invite = useMutation({
    mutationFn: (v: InviteValues) => api.staff.invite({ email: v.email, name: v.name || null, role: v.role }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['staff'] });
      reset();
      onClose();
    },
    onError: (e) => {
      if (isApiError(e) && (e.code === 'already_member' || e.code === 'invitation_pending')) {
        setError('email', { message: e.code === 'already_member' ? 'This person is already on your team.' : 'An invitation is already pending for this email.' });
      } else if (isApiError(e) && e.code === 'plan_limit_reached') {
        setFormError(e.fieldError('staff_seats') ?? 'All staff seats are in use. Remove someone or upgrade your plan.');
      } else if (isApiError(e) && e.isValidation) {
        for (const f of ['email', 'name', 'role'] as const) if (e.fieldError(f)) setError(f, { message: e.fieldError(f) });
      } else setFormError(isApiError(e) ? e.message : 'Could not send the invitation.');
    },
  });

  const left = seats && seats.seats_limit !== null ? seats.seats_limit - seats.seats_used : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Invite staff member"
      description="They’ll get an email with a link to set their password and sign in."
      className="max-w-[600px]"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="invite-staff" loading={invite.isPending} disabled={left !== null && left <= 0}>
            Send invite
          </Button>
        </>
      }
    >
      <form
        id="invite-staff"
        noValidate
        className="flex flex-col gap-5"
        onSubmit={handleSubmit((v) => {
          setFormError(null);
          invite.mutate(v);
        })}
      >
        {formError && <FormAlert>{formError}</FormAlert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Full name" placeholder="Tanvir Hasan" error={errors.name?.message} {...register('name')} />
          <Input label="Email" type="email" placeholder="name@example.com" error={errors.email?.message} {...register('email')} />
        </div>
        <fieldset className="flex flex-col gap-2.5">
          <legend className="mb-1.5 text-body font-medium text-text-primary">Role</legend>
          <Controller
            control={control}
            name="role"
            render={({ field }) =>
              (
                <>
                  {roleOptions.map((o) => {
                    const selected = field.value === o.value;
                    return (
                      <label
                        key={o.value}
                        className={cn(
                          'flex cursor-pointer items-center gap-3 rounded-lg px-4 py-3.5',
                          selected ? 'border-2 border-brand-600 bg-brand-50' : 'border border-border-default bg-surface-card',
                        )}
                      >
                        <input
                          type="radio"
                          name={field.name}
                          value={o.value}
                          checked={selected}
                          onChange={() => field.onChange(o.value)}
                          className="size-5 accent-brand-600"
                        />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="text-body font-semibold text-text-primary">{o.title}</span>
                          <span className="text-caption text-text-secondary">{o.detail}</span>
                        </span>
                        <span className="text-body font-semibold text-text-primary">{o.tag}</span>
                      </label>
                    );
                  })}
                </>
              )
            }
          />
        </fieldset>
        {left !== null && (
          <p className="flex items-center gap-2 rounded-md bg-brand-50 px-3.5 py-2.5 text-body text-text-primary">
            <Users aria-hidden className="size-4 text-brand-600" />
            {left <= 0
              ? `All ${seats!.seats_limit} staff seats are in use.`
              : left === 1
                ? `This uses your last free seat — ${seats!.seats_used + 1} of ${seats!.seats_limit} seats.`
                : `${left} of ${seats!.seats_limit} staff seats free.`}
          </p>
        )}
      </form>
    </Modal>
  );
}
