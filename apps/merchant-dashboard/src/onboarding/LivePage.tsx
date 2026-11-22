import { buttonVariants, ChecklistItem, downloadQr, Logo, ProgressBar, QrCode } from '@storeplix/ui';
import { Check, MessageCircle, Store as StoreIcon } from 'lucide-react';
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

  const copy = () =>
    void (navigator.clipboard?.writeText(url) ?? Promise.reject(new Error('no clipboard'))).then(
      () => toast('Shop link copied.'),
      () => toast(url),
    );
  const download = () => void downloadQr(url, `${scope.store!.slug}-qr.png`);

  // Mobile (M5 54:941): centred hero outside the card, compact share card with a QR row, sticky bottom bar.
  // Desktop (52:765): one success card (hero + link & QR column), checklist card, CTAs, bare phone preview.
  return (
    <div className="flex min-h-dvh flex-col bg-surface-canvas">
      <header className="flex items-center justify-between px-5 py-2 lg:border-b lg:border-border-default lg:bg-surface-card lg:px-10 lg:py-[18px]">
        <Logo height={32} />
        <span className="flex items-center gap-4">
          <a href="https://wa.me/8809678112233" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-body font-medium text-text-secondary lg:font-normal">
            <MessageCircle aria-hidden className="hidden size-4 lg:block" />
            <span className="lg:hidden">Help</span>
            <span className="hidden lg:inline">Help in Bangla</span>
          </a>
          <Link to="/" className={buttonVariants({ variant: 'secondary', size: 'sm', className: 'hidden lg:inline-flex' })}>
            Go to dashboard
          </Link>
        </span>
      </header>
      <div className="flex flex-1 justify-center gap-14 px-5 pt-5 pb-36 lg:px-8 lg:pt-12 lg:pb-8">
        <div className="flex w-full max-w-[720px] flex-col gap-5 lg:gap-6">
          <section
            aria-label="Your shop link"
            className="flex flex-col gap-5 lg:gap-7 lg:rounded-[20px] lg:border lg:border-border-default lg:bg-surface-card lg:p-8 lg:shadow-elevation-1"
          >
            {live ? (
              <div className="flex flex-col items-center gap-5 text-center lg:flex-row lg:text-left">
                <span className="flex size-16 shrink-0 items-center justify-center rounded-full border-2 border-success bg-success-bg text-success lg:size-[72px]">
                  <Check aria-hidden className="size-[30px] lg:size-9" />
                </span>
                <div className="flex flex-col gap-1.5">
                  <h1 className="text-heading-32 text-text-primary lg:text-display">You’re live 🎉</h1>
                  <p lang="bn" className="font-bangla text-body-lg leading-[26px] font-semibold text-brand-600 lg:text-[20px] lg:leading-8">
                    অভিনন্দন! {shopName} এখন অনলাইনে।
                  </p>
                  <p className="text-body text-text-secondary lg:text-body-lg">Share your link and get your first order today.</p>
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
            <div className="flex flex-col gap-3 rounded-card border border-border-default bg-surface-card p-4 shadow-elevation-1 lg:flex-row lg:gap-6 lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none">
              <div className="flex min-w-0 flex-1 flex-col gap-3">
                <span className="hidden text-caption font-medium text-text-secondary lg:block">Your shop link</span>
                <div className="flex h-12 items-center gap-2 rounded-control bg-surface-subtle pr-2 pl-3 lg:h-[52px] lg:gap-2.5 lg:border lg:border-border-default lg:pl-3.5">
                  <StoreIcon aria-hidden className="size-[18px] shrink-0 text-brand-600" />
                  <span className="min-w-0 flex-1 truncate text-body font-medium text-text-primary lg:text-body-lg">{domain}</span>
                  <button type="button" aria-label="Copy link" onClick={copy} className={buttonVariants({ size: 'sm' })}>
                    <span className="lg:hidden">Copy</span>
                    <span className="hidden lg:inline">Copy link</span>
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2 lg:gap-2.5">
                  <a
                    href={`https://www.facebook.com/sharer/sharer.php?u=${share}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Share to Facebook"
                    className={buttonVariants({ className: 'min-h-11 gap-2 bg-[#1877f2] hover:bg-[#166fe0]' })}
                  >
                    <span aria-hidden className="flex size-[18px] items-center justify-center rounded-full bg-surface-card text-body leading-none font-bold text-[#1877f2] lg:size-5">
                      f
                    </span>
                    <span className="lg:hidden">Facebook</span>
                    <span className="hidden lg:inline">Share to Facebook</span>
                  </a>
                  <a
                    href={`https://wa.me/?text=${share}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Share on WhatsApp"
                    className={buttonVariants({ className: 'min-h-11 gap-2 bg-[#25d366] hover:bg-[#20bd5a]' })}
                  >
                    <MessageCircle aria-hidden className="size-[18px]" />
                    <span className="lg:hidden">WhatsApp</span>
                    <span className="hidden lg:inline">Share on WhatsApp</span>
                  </a>
                </div>
                <p className="hidden text-caption text-text-muted lg:block">Tip: pin the link on your Facebook page and add it to your Instagram bio.</p>
              </div>
              {/* QR: mobile row (98 tile + copy) / desktop card (126 code, Scan to visit). */}
              <div className="flex items-center gap-3.5 pt-1 lg:hidden">
                <span className="rounded-control border border-border-default bg-surface-card p-[7px]">
                  <QrCode value={url} size={84} label={`QR code for ${domain}`} />
                </span>
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="text-body font-semibold text-text-primary">Your shop QR</span>
                  <span className="text-caption text-text-secondary">Print it on packaging or your shop counter.</span>
                  <button type="button" className="self-start text-caption font-medium text-brand-600" onClick={download}>
                    Download QR
                  </button>
                </span>
              </div>
              <div className="hidden flex-col items-center gap-2 self-start rounded-[14px] border border-border-default bg-surface-card p-3.5 lg:flex">
                <QrCode value={url} size={126} label={`QR code for ${domain}`} />
                <span className="text-caption text-text-secondary">Scan to visit</span>
                <button type="button" className="text-caption font-medium text-brand-600" onClick={download}>
                  Download QR
                </button>
              </div>
            </div>
          </section>

          <section aria-label="Finish setting up" className="flex flex-col gap-2.5 rounded-card border border-border-default bg-surface-card p-4 shadow-elevation-1 lg:gap-3 lg:rounded-[20px] lg:p-7">
            <div className="flex flex-col gap-2.5 lg:flex-row lg:items-start lg:justify-between lg:gap-4 lg:pb-1">
              <div className="flex items-center justify-between gap-4 lg:flex-col lg:items-start lg:gap-1">
                <h2 className="text-body-lg font-semibold text-text-primary lg:text-heading">Finish setting up</h2>
                <span className="text-body font-medium text-brand-600 lg:hidden">
                  {doneCount} of {items.length} done
                </span>
                <p className="hidden text-body text-text-secondary lg:block">Shops that finish these get their first order faster.</p>
              </div>
              <div className="flex shrink-0 flex-col gap-1.5 lg:mt-[9px] lg:w-40">
                <span className="hidden text-right text-body font-medium text-brand-600 lg:block">
                  {doneCount} of {items.length} done
                </span>
                <ProgressBar value={doneCount / items.length} label="Finish setting up" className="lg:h-2 lg:rounded-full" />
              </div>
            </div>
            <ul className="flex flex-col gap-2.5 lg:gap-3">
              {items.map((i) => (
                <li key={i.key}>
                  <ChecklistItem title={i.title} hint={i.hint} state={i.done ? 'done' : 'todo'} onSelect={!i.done && i.to ? () => navigate(i.to!) : undefined} />
                </li>
              ))}
            </ul>
          </section>

          <div className="fixed inset-x-0 bottom-0 z-10 flex flex-col gap-3 border-t border-border-default bg-surface-card px-5 pt-4 pb-[max(16px,env(safe-area-inset-bottom))] lg:static lg:flex-row lg:border-0 lg:bg-transparent lg:p-0">
            <Link to="/" className={buttonVariants()}>
              Go to dashboard
            </Link>
            <a href={url} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: 'secondary', className: 'min-h-5 border-0 bg-transparent py-0 text-text-secondary lg:min-h-10 lg:border lg:bg-surface-card lg:py-2 lg:text-text-primary' })}>
              View my shop
            </a>
          </div>
        </div>
        <PhonePreview
          bare
          name={scope.store.name}
          domain={domain}
          footer={
            <span className="flex flex-col items-center gap-3 pt-1 text-center">
              <span className="text-body font-semibold text-text-primary">Live on every phone</span>
              <span className="text-caption text-text-muted">Customers order in seconds — no app, no login.</span>
            </span>
          }
        />
      </div>
    </div>
  );
}

export default LivePage;
