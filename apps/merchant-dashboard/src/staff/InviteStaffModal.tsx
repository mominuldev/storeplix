import { zodResolver } from '@hookform/resolvers/zod';
import { isApiError } from '@storeplix/api-client';
import type { Role, StaffSeatsMeta } from '@storeplix/types';
import { Button, Input, Modal, Spinner } from '@storeplix/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useAuth } from '../auth/AuthProvider';
import { inviteSchema, type InviteValues } from '../auth/schemas';
import { api } from '../lib/api';
import { FormAlert } from '../onboarding/AuthShell';
import { handlePlanLimit } from '../plan/Banners';
import { RoleOptions } from './RoleOptions';
import { assignableRoles } from './roles';

// Figma Invite modal 90:26879 — w 600; Full name + Email (Figma: phone → email, SMS not used for invites, Q121);
// role radio cards = assignable roles (Manager, Staff, then custom roles; N5-disabled with a reason; custom roles
// hidden without `custom_roles`). Not built: Warehouse access (Q119), "Permissions for this person" (Q120).
export function InviteStaffModal({
  open,
  onClose,
  seats,
  roles,
  rolesLoading = false,
  customRolesEnabled,
}: {
  open: boolean;
  onClose: () => void;
  seats?: StaffSeatsMeta;
  roles: readonly Role[] | undefined;
  rolesLoading?: boolean;
  customRolesEnabled: boolean;
}) {
  const queryClient = useQueryClient();
  const { activeTenant: me } = useAuth();
  const [formError, setFormError] = useState<string | null>(null);
  const options = assignableRoles(me, roles, customRolesEnabled);
  const fallback = options.find((o) => o.allowed && o.role.key === 'staff')?.role.id ?? options.find((o) => o.allowed)?.role.id ?? '';
  const {
    register,
    control,
    handleSubmit,
    reset,
    setError,
    getValues,
    setValue,
    formState: { errors },
  } = useForm<InviteValues>({ resolver: zodResolver(inviteSchema), defaultValues: { name: '', email: '', role_id: fallback } });

  // Roles load after the modal mounts: default to Staff once they arrive.
  useEffect(() => {
    if (!getValues('role_id') && fallback) setValue('role_id', fallback);
  }, [fallback, getValues, setValue]);

  const invite = useMutation({
    mutationFn: (v: InviteValues) => api.staff.invite({ email: v.email, name: v.name || null, role_id: v.role_id }),
    onSuccess: async () => {
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['staff'] }), queryClient.invalidateQueries({ queryKey: ['roles'] })]);
      reset({ name: '', email: '', role_id: fallback });
      onClose();
    },
    onError: (e) => {
      if (isApiError(e) && (e.code === 'already_member' || e.code === 'invitation_pending')) {
        setError('email', { message: e.code === 'already_member' ? 'This person is already on your team.' : 'An invitation is already pending for this email.' });
      } else if (isApiError(e) && e.code === 'plan_limit_reached') {
        setFormError(e.fieldError('staff_seats') ?? 'All staff seats are in use. Remove someone or upgrade your plan.');
      } else if (isApiError(e) && e.code === 'feature_not_in_plan') {
        handlePlanLimit(e);
      } else if (isApiError(e) && e.isValidation) {
        for (const f of ['email', 'name', 'role_id'] as const) if (e.fieldError(f)) setError(f, { message: e.fieldError(f) });
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
          <Button type="submit" form="invite-staff" loading={invite.isPending} disabled={(left !== null && left <= 0) || !options.some((o) => o.allowed)}>
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
        {rolesLoading ? (
          <div className="flex justify-center py-4">
            <Spinner label="Loading roles" />
          </div>
        ) : (
          <Controller
            control={control}
            name="role_id"
            render={({ field }) => <RoleOptions name={field.name} options={options} value={field.value} onChange={field.onChange} me={me} />}
          />
        )}
        {errors.role_id?.message && <p className="text-caption text-danger">{errors.role_id.message}</p>}
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
