import { Button, Card, EmptyState, Logo, Spinner, buttonVariants } from '@storeplix/ui';
import { Ban, Link2Off, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ADMIN_APP_URL, SUPPORT_URL } from '../lib/links';

/**
 * Full-page state composed from the Figma error state (section 148:34032): Store Plix logo above one card with an icon,
 * title, description and actions. Used by the impersonation link, ended and suspended screens.
 */
export function StatusScreen({ icon, title, description, actions }: { icon: ReactNode; title: string; description: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-8 bg-surface-canvas px-4 py-10">
      <Logo height={32} />
      <Card className="w-full max-w-md">
        <EmptyState
          icon={icon}
          title={title}
          description={description}
          action={actions ? <div className="flex flex-wrap items-center justify-center gap-3">{actions}</div> : undefined}
        />
      </Card>
    </div>
  );
}

const adminLink = (label: string) => (
  <a href={ADMIN_APP_URL} className={buttonVariants()}>
    {label}
  </a>
);

/** Contract §7.2: after Exit, expiry (mm:ss reached 0) or a 401 `impersonation_ended`. Never the login page. */
export function ImpersonationEndedScreen() {
  return (
    <StatusScreen
      icon={<ShieldCheck />}
      title="Impersonation ended"
      description="This read-only support session is over and you are signed out of the shop. Nothing was changed."
      actions={adminLink('Back to Store Plix admin')}
    />
  );
}

/** `/impersonate` with a missing, used or expired ticket. */
export function ImpersonationLinkExpiredScreen() {
  return (
    <StatusScreen
      icon={<Link2Off />}
      title="This link has expired"
      description="This link has expired. Start again from Store Plix admin."
      actions={adminLink('Open Store Plix admin')}
    />
  );
}

export function ImpersonationStartingScreen() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface-canvas">
      <Spinner size="lg" label="Opening the shop (read-only)" />
    </div>
  );
}

/** Contract §7.2 / P8-12: 403 `tenant_suspended` on the merchant API. */
export function SuspendedShopScreen({ onSignOut, canSwitch }: { onSignOut: () => void; canSwitch?: boolean }) {
  return (
    <StatusScreen
      icon={<Ban />}
      title="Your shop is suspended"
      description="Your shop and its online store are paused. Your data is kept safe. Contact Store Plix support to find out why and how to reactivate it."
      actions={
        <>
          <a href={SUPPORT_URL} className={buttonVariants()}>
            Contact Store Plix support
          </a>
          {canSwitch && (
            <Link to="/choose-shop" className={buttonVariants({ variant: 'secondary' })}>
              Switch shop
            </Link>
          )}
          <Button variant="secondary" onClick={onSignOut}>
            Sign out
          </Button>
        </>
      }
    />
  );
}
