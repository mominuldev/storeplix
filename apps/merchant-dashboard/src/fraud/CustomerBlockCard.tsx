import { Button } from '@storeplix/ui';
import { useState } from 'react';
import { Link } from 'react-router';
import { formatIntlPhone } from '../catalog/format';
import { ReadOnlyActions } from '../impersonation/ReadOnlyActions';
import { useFeatures } from '../plan/useFeatures';
import { BlockNumberDialog } from './dialogs';
import { guardLocked } from './fraud';
import { useBlockedNumbers } from './queries';

// PHASE-8-8 §10.3 customer detail "Block this number" 64:16887 (with `fraud.manage`). Already blocked → says so and
// links to the blocked list (unblock lives there). Free plan → the button is disabled (writes 402).

export function CustomerBlockCard({ phone }: { phone: string }) {
  const [open, setOpen] = useState(false);
  const locked = guardLocked(useFeatures().data);
  const blocked = useBlockedNumbers(phone.slice(-8), 'recent');
  const isBlocked = (blocked.data?.pages[0]?.data ?? []).some((b) => b.phone === phone);
  return (
    <section aria-label="Block this number" className="flex flex-col gap-2 rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1">
      <h2 className="text-body-lg font-medium text-text-primary">{isBlocked ? 'This number is blocked' : 'Block this number'}</h2>
      {isBlocked ? (
        <p className="text-body text-text-secondary">
          Cash on delivery is off for {formatIntlPhone(phone)}. They can still pay online.{' '}
          <Link to="/orders/fraud-guard/blocked" className="font-medium text-brand-600">
            Manage blocked numbers
          </Link>
        </p>
      ) : (
        <>
          <p className="text-body text-text-secondary">Blocked numbers can’t place COD orders on your shop. You can unblock any time.</p>
          <ReadOnlyActions className="pt-1">
            <Button variant="danger" size="sm" disabled={locked || blocked.isPending} onClick={() => setOpen(true)}>
              Block {formatIntlPhone(phone)}
            </Button>
          </ReadOnlyActions>
        </>
      )}
      {open && <BlockNumberDialog initialPhone={phone} onClose={() => setOpen(false)} />}
    </section>
  );
}
