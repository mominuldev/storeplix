import type { StaffMember, TenantRole } from '@storeplix/types';
import { Button, Modal } from '@storeplix/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { api } from '../lib/api';
import { can, roleLabel } from '../lib/permissions';

type Action = { label: string; danger?: boolean; run: () => void };

/** Row action menu (Figma: 32px icon button with ChevronDown). Only actions the viewer may perform are shown. */
export function MemberActions({ member, viewerRole }: { member: StaffMember; viewerRole: TenantRole | undefined }) {
  const queryClient = useQueryClient();
  const { logout, refreshUser } = useAuth();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const done = async () => {
    setOpen(false);
    setConfirm(false);
    await queryClient.invalidateQueries({ queryKey: ['staff'] });
  };
  const onError = (e: Error) => setError(e.message);

  const role = useMutation({ mutationFn: (r: 'admin' | 'staff') => api.staff.updateRole(member.id, { role: r }), onSuccess: done, onError });
  const remove = useMutation({
    mutationFn: () => api.staff.remove(member.id),
    onSuccess: async () => {
      if (member.is_you) {
        await refreshUser();
        return void logout();
      }
      await done();
    },
    onError,
  });
  const resend = useMutation({ mutationFn: () => api.staff.resendInvitation(member.id), onSuccess: done, onError });
  const revoke = useMutation({ mutationFn: () => api.staff.revokeInvitation(member.id), onSuccess: done, onError });

  const actions: Action[] = [];
  if (can.changeRole(viewerRole, member)) {
    const other = member.role === 'admin' ? 'staff' : 'admin';
    actions.push({ label: `Make ${roleLabel[other]}`, run: () => role.mutate(other) });
  }
  if (can.manageInvitation(viewerRole, member)) {
    actions.push({ label: 'Resend invite', run: () => resend.mutate() });
    actions.push({ label: 'Cancel invite', danger: true, run: () => revoke.mutate() });
  }
  if (can.removeMember(viewerRole, member)) {
    actions.push({ label: member.is_you ? 'Leave shop' : 'Remove from shop', danger: true, run: () => setConfirm(true) });
  }
  if (actions.length === 0) return <span className="size-8" />;

  const who = member.name ?? member.email;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={`Actions for ${who}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex size-8 items-center justify-center rounded-md border border-border-default bg-surface-card text-text-secondary outline-none hover:bg-surface-subtle focus-visible:shadow-focus"
      >
        <ChevronDown aria-hidden className="size-4" />
      </button>
      {open && (
        <ul role="menu" className="absolute top-full right-0 z-30 mt-1 w-48 rounded-lg border border-border-default bg-surface-card p-1 shadow-elevation-1">
          {actions.map((a) => (
            <li key={a.label} role="none">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setError(null);
                  a.run();
                }}
                className={`w-full rounded-md px-3 py-2 text-left text-body hover:bg-surface-subtle ${a.danger ? 'text-danger' : 'text-text-primary'}`}
              >
                {a.label}
              </button>
            </li>
          ))}
          {error && <li className="px-3 py-2 text-caption text-danger">{error}</li>}
        </ul>
      )}
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={member.is_you ? 'Leave this shop?' : `Remove ${who}?`}
        description={member.is_you ? 'You’ll lose access right away. The owner can invite you again.' : 'They lose access right away. Their past actions stay in the activity log.'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
              {member.is_you ? 'Leave shop' : 'Remove'}
            </Button>
          </>
        }
      >
        {error && <p className="text-body text-danger">{error}</p>}
      </Modal>
    </div>
  );
}
