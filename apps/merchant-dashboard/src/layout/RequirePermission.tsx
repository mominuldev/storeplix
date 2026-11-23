import { EmptyState } from '@storeplix/ui';
import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { Outlet } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import type { PermissionHolder } from '../lib/permissions';
import { PageHeader } from './PageHeader';

/** States 148:34032 composition (card + neutral icon + title + description) for a page the member can't open. */
export function NoAccessState({ title = 'You don’t have access to this page', description = 'Ask your shop owner or a manager to change your role.', heading }: { title?: string; description?: string; heading?: string }) {
  return (
    <>
      {heading && <PageHeader title={heading} />}
      <section className="rounded-card border border-border-default bg-surface-card shadow-elevation-1">
        <EmptyState icon={<Lock />} title={title} description={description} />
      </section>
    </>
  );
}

/**
 * PHASE-8-3 §7.1: a deep link without the permission shows the no-access state (the API would 403 anyway).
 * Use as a layout route (renders `<Outlet />`) or wrap `children`.
 */
export function RequirePermission({ allow, children }: { allow: (m: PermissionHolder) => boolean; children?: ReactNode }) {
  const { activeTenant } = useAuth();
  if (!allow(activeTenant)) return <NoAccessState />;
  return children ?? <Outlet />;
}
