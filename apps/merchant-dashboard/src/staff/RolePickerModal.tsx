import { isApiError } from '@storeplix/api-client';
import type { Role, StaffMember } from '@storeplix/types';
import { Button, Modal } from '@storeplix/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { api } from '../lib/api';
import { toast } from '../online-store/components/Toast';
import { handlePlanLimit } from '../plan/Banners';
import { RoleOptions } from './RoleOptions';
import { assignableRoles } from './roles';

/** PHASE-8-3 §7.2 "Change role": the roles the actor may assign (N5), same radio cards as the invite modal (90:26879). */
export function RolePickerModal({ member, roles, customRolesEnabled, onClose }: { member: StaffMember; roles: readonly Role[] | undefined; customRolesEnabled: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { activeTenant: me } = useAuth();
  const [value, setValue] = useState<string | null>(member.role_id ?? null);
  const [error, setError] = useState<string | null>(null);
  const options = assignableRoles(me, roles, customRolesEnabled);
  const who = member.name ?? member.email;

  const save = useMutation({
    mutationFn: (roleId: string) => api.staff.updateRole(member.id, { role_id: roleId }),
    onSuccess: async (_d, roleId) => {
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['staff'] }), queryClient.invalidateQueries({ queryKey: ['roles'] })]);
      toast(`${who} is now ${roles?.find((r) => r.id === roleId)?.name ?? 'updated'}.`);
      onClose();
    },
    onError: (e) => {
      if (handlePlanLimit(e)) return onClose();
      setError(isApiError(e) ? e.message : 'Could not change the role.');
    },
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={`Change ${who}’s role`}
      description="The new role applies from their next action. They stay signed in."
      className="max-w-[600px]"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={!value || value === member.role_id} onClick={() => value && save.mutate(value)}>
            Save role
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && (
          <p role="alert" className="rounded-md bg-danger-bg px-3.5 py-2.5 text-body text-danger">
            {error}
          </p>
        )}
        <RoleOptions name={`role-${member.id}`} options={options} value={value} onChange={setValue} me={me} />
      </div>
    </Modal>
  );
}
