import { isApiError } from '@storeplix/api-client';
import type { ThemeCatalogEntry } from '@storeplix/types';
import { Badge, Button, cn, ColorSwatch, ProgressBar, Spinner } from '@storeplix/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Check, ChevronLeft, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../lib/api';
import { can } from '../lib/permissions';
import { useAuth } from '../auth/AuthProvider';
import { FormAlert } from '../onboarding/AuthShell';
import { PhonePreview } from '../onboarding/PhonePreview';
import { StepRail } from '../onboarding/StepRail';
import { useThemeCatalog } from '../online-store/hooks';
import { themeThumbnail } from '../online-store/themeAssets';
import { settingsKey } from '../settings/schema';
import { useBrandUpload } from '../settings/useBrandUpload';
import { storeDomain, useTenantStore } from '../stores/useTenantStore';

// Figma Merchant Onboarding · 04 Pick a theme 48:8119 (desktop) / M4 54:810 (mobile). Theme cards from GET /themes
// (available themes selectable; coming-soon cards disabled with a badge; max 4 as designed), "Make it yours"
// swatches + custom hex, logo upload (purpose logo), tinted phone preview. Submit: POST themes/{code}/apply →
// PATCH settings {branding: {primary_color, logo_media_id?}} → dashboard.

const SWATCHES = [
  { color: '#5b53ff', label: 'Violet' },
  { color: '#fc856d', label: 'Coral' },
  { color: '#14833b', label: 'Green' },
  { color: '#c8312b', label: 'Red' },
  { color: '#0d0d18', label: 'Ink' },
];
const HEX = /^#[0-9a-f]{6}$/;

export function PickThemePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { activeTenant } = useAuth();
  const store = useTenantStore().data!;
  const catalog = useThemeCatalog();
  const logoUpload = useBrandUpload('logo');
  const fileRef = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [color, setColor] = useState('#5b53ff');
  const [hex, setHex] = useState('#5B53FF');
  const [logo, setLogo] = useState<{ id: string; url: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canEdit = can.editSettings(activeTenant?.role);

  const themes = (catalog.data ?? []).slice().sort((a, b) => Number(b.status === 'available') - Number(a.status === 'available')).slice(0, 4);
  const selectable = (t: ThemeCatalogEntry) => t.status === 'available' && t.tier === 'free';
  const selected = themes.find((t) => t.code === picked) ?? themes.find(selectable) ?? null;

  const submit = async () => {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.storeThemes.apply(store.id, selected.code);
      const settings = await api.stores.updateSettings(store.id, { branding: { primary_color: color, ...(logo ? { logo_media_id: logo.id } : {}) } });
      queryClient.setQueryData(settingsKey(store.id), settings);
      await queryClient.invalidateQueries({ queryKey: ['store-themes'] });
      // Phase 4 §9.1: step 05 "Add first products" follows.
      navigate('/onboarding/products', { replace: true });
    } catch (e) {
      setError(isApiError(e) ? (e.code === 'theme_unavailable' ? 'This theme isn’t available yet. Pick another one.' : e.message) : 'Something went wrong. Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-dvh bg-surface-canvas">
      <StepRail shopName={store.name} current={4} />
      <div className="flex min-w-0 flex-1 flex-col lg:items-center">
        <div className="hidden w-full items-center justify-between px-10 py-5 lg:flex">
          <span className="text-caption font-medium text-text-secondary">Step 4 of 7</span>
          <Button variant="ghost" size="sm" onClick={() => navigate('/')}>
            Save & exit
          </Button>
        </div>
        <header className="flex flex-col gap-3 px-4 pt-2 pb-3 lg:hidden">
          <div className="flex items-center justify-between">
            <button type="button" aria-label="Back" onClick={() => navigate(-1)} className="flex size-9 items-center justify-center rounded-full border border-border-default bg-surface-card">
              <ChevronLeft aria-hidden className="size-[18px]" />
            </button>
            <span className="text-body font-semibold text-text-primary">Step 4 of 7</span>
            <button type="button" onClick={() => navigate('/')} className="text-caption font-medium text-brand-600">
              Skip
            </button>
          </div>
          <ProgressBar value={4 / 7} label="Setup progress" className="h-1 rounded-[2px]" />
        </header>

        <div className="flex w-full max-w-[620px] flex-1 flex-col gap-5 px-5 pt-3 pb-28 lg:gap-7 lg:px-0 lg:pt-2 lg:pb-12">
          <div className="flex flex-col gap-1.5 lg:gap-2">
            <h1 className="text-heading-24 text-text-primary lg:text-heading-32">Pick a look for your shop</h1>
            <p className="text-body text-text-secondary lg:text-body-lg">Every theme is mobile-first and fast on 3G. You can switch later without losing anything.</p>
          </div>
          {error && <FormAlert>{error}</FormAlert>}

          {catalog.isPending ? (
            <div className="flex h-48 items-center justify-center">
              <Spinner label="Loading themes" />
            </div>
          ) : catalog.isError ? (
            <FormAlert>We couldn’t load themes. Check your connection and refresh.</FormAlert>
          ) : (
            <ul role="radiogroup" aria-label="Theme" className="grid grid-cols-2 gap-3 lg:gap-4">
              {themes.map((t) => {
                const ok = selectable(t);
                const on = selected?.code === t.code;
                const thumb = themeThumbnail(t);
                return (
                  <li key={t.code}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={on}
                      aria-disabled={!ok}
                      disabled={!ok}
                      onClick={() => setPicked(t.code)}
                      className={cn(
                        'flex h-full w-full flex-col gap-3 rounded-card bg-surface-card p-2.5 text-left outline-none focus-visible:shadow-focus disabled:cursor-not-allowed',
                        on ? 'shadow-[inset_0_0_0_2px_var(--color-brand-600)]' : 'shadow-[inset_0_0_0_1px_var(--color-border-default)]',
                      )}
                    >
                      <span className={cn('block aspect-[352/236] overflow-hidden rounded-lg bg-surface-subtle', !ok && 'opacity-60')}>{thumb && <img src={thumb} alt="" className="size-full object-cover" />}</span>
                      <span className="flex items-end justify-between gap-2 px-1 pb-1">
                        <span className="flex min-w-0 flex-col">
                          <span className="text-body-lg font-semibold text-text-primary">{t.name}</span>
                          <span className="truncate text-caption text-text-secondary">{t.description}</span>
                        </span>
                        {on ? (
                          <span className="flex shrink-0 items-center gap-1 rounded-full bg-brand-600 px-2.5 py-1 text-caption font-medium text-text-inverse">
                            <Check aria-hidden className="size-3.5" /> Selected
                          </span>
                        ) : !ok ? (
                          <Badge className="shrink-0">Coming soon</Badge>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <section aria-labelledby="make-it-yours" className="flex flex-col gap-4 rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1 lg:p-6">
            <div className="flex flex-col gap-1">
              <h2 id="make-it-yours" className="text-body-lg font-medium text-text-primary">
                Make it yours
              </h2>
              <p className="text-body text-text-secondary">Your colour is used on buttons, banners and the checkout.</p>
            </div>
            <div className="flex flex-wrap items-center gap-3" role="group" aria-label="Brand colour">
              {SWATCHES.map((s) => (
                <ColorSwatch
                  key={s.color}
                  color={s.color}
                  label={s.label}
                  selected={color === s.color}
                  onClick={() => {
                    setColor(s.color);
                    setHex(s.color.toUpperCase());
                  }}
                />
              ))}
              <label className="flex h-10 items-center gap-2 rounded-md border border-border-default px-3">
                <span className="text-caption text-text-muted">Custom</span>
                <input
                  aria-label="Custom colour hex"
                  value={hex}
                  maxLength={7}
                  onChange={(e) => {
                    const v = (e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}`).toUpperCase();
                    setHex(v);
                    if (HEX.test(v.toLowerCase())) setColor(v.toLowerCase());
                  }}
                  className="w-20 bg-transparent text-body font-medium text-text-primary uppercase outline-none"
                />
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-4 rounded-lg border border-dashed border-border-strong bg-surface-subtle p-4">
              <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-full text-heading text-text-inverse" style={{ backgroundColor: color }}>
                {logo ? <img src={logo.url} alt="Your logo" className="size-full object-cover" /> : store.name.charAt(0).toUpperCase()}
              </span>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-body font-semibold text-text-primary">Upload your logo</span>
                <span className="text-caption text-text-secondary">{logoUpload.error ?? 'No logo yet? We made this one from your shop name. PNG, JPG or WebP, square, max 2 MB.'}</span>
              </div>
              <Button size="sm" variant="secondary" leftIcon={<Upload aria-hidden className="size-3.5" />} loading={logoUpload.progress !== null || logoUpload.processing} onClick={() => fileRef.current?.click()}>
                {logo ? 'Replace' : 'Upload'}
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept={logoUpload.rule.accept}
                className="sr-only"
                aria-label="Logo file"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  const r = await logoUpload.upload(file);
                  if (r) setLogo(r);
                }}
              />
            </div>
          </section>

          <div className="fixed inset-x-0 bottom-0 flex items-center justify-between gap-3 border-t border-border-default bg-surface-card px-5 pt-4 pb-[max(16px,env(safe-area-inset-bottom))] lg:static lg:border-0 lg:bg-transparent lg:p-0">
            <Button variant="ghost" className="hidden lg:inline-flex" leftIcon={<ChevronLeft aria-hidden className="size-4" />} onClick={() => navigate(-1)}>
              Back
            </Button>
            <Button className="w-full lg:w-auto" loading={submitting} disabled={!selected || !canEdit} onClick={() => void submit()}>
              {selected ? `Use ${selected.name} theme` : 'Pick a theme'}
            </Button>
          </div>
        </div>
      </div>
      <PhonePreview name={store.name} domain={storeDomain(store)} color={color} logoUrl={logo?.url} caption={selected ? `${selected.name} · ${hex}` : ''} />
    </div>
  );
}
