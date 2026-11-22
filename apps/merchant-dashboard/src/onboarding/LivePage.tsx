import { buttonVariants, ChecklistItem, downloadQr, Logo, ProgressBar, QrCode } from '@storeplix/ui';
import { Check, Copy, MessageCircle, Store as StoreIcon } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock } from '../catalog/states';
import { useLaunchChecklist } from '../commerce/queries';
import { LoadingState } from '../online-store/components/Shell';
import { toast } from '../online-store/components/Toast';
import { storeDomain } from '../stores/useTenantStore';
import { finishItems } from './launch';
import { PhonePreview } from './PhonePreview';

// Figma Merchant Onboarding · 08 You're live 52:765 (mobile 54:941). Contract §9: shop link + Copy, Share to Facebook,
// Share on WhatsApp, client-side QR with Download QR (PNG), "Finish setting up" from GET /launch-checklist, Go to
// dashboard / View my shop, phone preview. Not built (§11): Connect Meta Pixel.

export function LivePage() {
  const navigate = useNavigate();
  const scope = useStoreScope();
  const checklist = useLaunchChecklist();
  if (!scope.store || checklist.isPending) return <LoadingState label="Loading" />;
  if (checklist.isError) return <ErrorBlock error={checklist.error} onRetry={() => void checklist.refetch()} />;
  const c = checklist.data;
  const domain = storeDomain(scope.store);
  const url = c.shop_url || `https://${domain}`;
  const live = c.status === 'active';
  const items = finishItems(c, domain);
  const doneCount = items.filter((i) => i.done).length;
  const share = encodeURIComponent(url);
  const shopName = scope.store.name_bn || scope.store.name;

  return (
    <div className="flex min-h-dvh flex-col bg-surface-canvas">
      <header className="flex items-center justify-between border-b border-border-default bg-surface-card px-5 py-4 lg:px-8">
        <Logo height={28} />
        <span className="flex items-center gap-3">
          <a href="https://wa.me/8809678112233" target="_blank" rel="noopener noreferrer" className="hidden items-center gap-1.5 text-body text-text-secondary sm:flex">
            <MessageCircle aria-hidden className="size-4" /> Help in Bangla
          </a>
          <Link to="/" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
            Go to dashboard
          </Link>
        </span>
      </header>
      <div className="flex flex-1 justify-center gap-10 px-4 py-8 lg:px-8">
        <div className="flex w-full max-w-[560px] flex-col gap-5">
          <section aria-label="Your shop link" className="flex flex-col gap-5 rounded-card border border-border-default bg-surface-card p-6 shadow-elevation-1">
            {live ? (
              <div className="flex items-start gap-4">
                <span className="flex size-14 shrink-0 items-center justify-center rounded-full border-2 border-success bg-success-bg text-success">
                  <Check aria-hidden className="size-7" />
                </span>
                <div className="flex flex-col gap-1">
                  <h1 className="text-heading-32 text-text-primary">You’re live 🎉</h1>
                  <p lang="bn" className="font-bangla text-body-lg font-semibold text-brand-600">
                    অভিনন্দন! {shopName} এখন অনলাইনে।
                  </p>
                  <p className="text-body text-text-secondary">Share your link and get your first order today.</p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <h1 className="text-heading-24 text-text-primary">Your shop isn’t live yet</h1>
                <p className="text-body text-text-secondary">Finish the last step to publish it.</p>
                <button type="button" onClick={() => navigate('/onboarding/payments')} className={buttonVariants({ size: 'sm', className: 'self-start' })}>
                  Go live
                </button>
              </div>
            )}
            <div className="flex flex-col gap-4 sm:flex-row">
              <div className="flex min-w-0 flex-1 flex-col gap-3">
                <span className="text-caption text-text-secondary">Your shop link</span>
                <div className="flex items-center gap-2 rounded-md bg-surface-subtle py-1.5 pr-1.5 pl-3">
                  <StoreIcon aria-hidden className="size-4 shrink-0 text-brand-600" />
                  <span className="min-w-0 flex-1 truncate text-body font-medium text-text-primary">{domain}</span>
                  <button
                    type="button"
                    onClick={() =>
                      void (navigator.clipboard?.writeText(url) ?? Promise.reject(new Error('no clipboard'))).then(
                        () => toast('Shop link copied.'),
                        () => toast(url),
                      )
                    }
                    className={buttonVariants({ size: 'sm' })}
                  >
                    <Copy aria-hidden className="size-3.5" /> Copy link
                  </button>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <a href={`https://www.facebook.com/sharer/sharer.php?u=${share}`} target="_blank" rel="noopener noreferrer" className={buttonVariants({ className: 'bg-[#1877f2] hover:bg-[#166fe0]' })}>
                    Share to Facebook
                  </a>
                  <a href={`https://wa.me/?text=${share}`} target="_blank" rel="noopener noreferrer" className={buttonVariants({ className: 'bg-[#25d366] hover:bg-[#20bd5a]' })}>
                    Share on WhatsApp
                  </a>
                </div>
                <p className="text-caption text-text-muted">Tip: pin the link on your Facebook page and add it to your Instagram bio.</p>
              </div>
              <div className="flex flex-col items-center gap-1.5 rounded-lg border border-border-default p-3">
                <QrCode value={url} size={112} label={`QR code for ${domain}`} />
                <span className="text-caption text-text-muted">Scan to visit</span>
                <button type="button" className="text-caption font-medium text-brand-600" onClick={() => void downloadQr(url, `${scope.store!.slug}-qr.png`)}>
                  Download QR
                </button>
              </div>
            </div>
          </section>

          <section aria-label="Finish setting up" className="flex flex-col gap-4 rounded-card border border-border-default bg-surface-card p-6 shadow-elevation-1">
            <div className="flex items-start justify-between gap-4">
              <div className="flex flex-col gap-1">
                <h2 className="text-heading text-text-primary">Finish setting up</h2>
                <p className="text-body text-text-secondary">Shops that finish these get their first order faster.</p>
              </div>
              <div className="flex w-32 flex-col gap-1.5">
                <span className="text-right text-caption font-medium text-brand-600">
                  {doneCount} of {items.length} done
                </span>
                <ProgressBar value={doneCount / items.length} label="Finish setting up" />
              </div>
            </div>
            <ul className="flex flex-col gap-2">
              {items.map((i) => (
                <li key={i.key}>
                  <ChecklistItem title={i.title} hint={i.hint} state={i.done ? 'done' : 'todo'} onSelect={!i.done && i.to ? () => navigate(i.to!) : undefined} />
                </li>
              ))}
            </ul>
          </section>

          <div className="flex flex-wrap gap-3">
            <Link to="/" className={buttonVariants()}>
              Go to dashboard
            </Link>
            <a href={url} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: 'secondary' })}>
              View my shop
            </a>
          </div>
        </div>
        <PhonePreview name={scope.store.name} domain={domain} caption="Live on every phone" />
      </div>
    </div>
  );
}

export default LivePage;
