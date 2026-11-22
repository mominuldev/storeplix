import { isApiError } from '@storeplix/api-client';
import type { StoreTheme, ThemeGlobalSettings } from '@storeplix/types';
import { Button, cn, contrastRatio, Dialog, DraftBar, DraftBarGhostButton, SegmentedControl, Spinner } from '@storeplix/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, ShoppingCart } from 'lucide-react';
import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { settingsKey } from '../settings/schema';
import { useBrandUpload } from '../settings/useBrandUpload';
import { storeDomain, useTenantStore } from '../stores/useTenantStore';
import { ConflictDialog, ErrorState, LoadingState, OnlineStoreHeader, Panel, ReadOnlyBanner } from './components/Shell';
import { MediaPicker } from './components/MediaPicker';
import { toast } from './components/Toast';
import { summarizeChanges } from './editor/changes';
import { editorReducer, initEditor } from './editor/editorReducer';
import { osKeys, useActiveTheme, useCanEditStore } from './hooks';
import { getThemeDefinition } from './theme-package';
import kurti from '../assets/onboarding/preview-kids-kurti.png';
import jamdani from '../assets/onboarding/preview-jamdani-3piece.png';
import panjabi from '../assets/onboarding/preview-cotton-panjabi.png';
import silk from '../assets/onboarding/preview-silk-saree.png';

// Figma V3 Brand style 2035:46054 (Main 2035:46056). Colours, fonts and corners are theme draft (PUT draft,
// Publish = publish). Logo, favicon and share image are store-level and save immediately (contract P3-7).
// The preview card's Live / New toggle switches between the published and draft settings; Desktop / Phone
// switches the static mock's frame.

const HEX = /^#[0-9a-f]{6}$/;

/** Darkens (or lightens on dark backgrounds) until the colour reads at 4.5:1 on `bg` — "Fix for me". */
export function readableInk(color: string, bg: string): string {
  if (!HEX.test(color) || !HEX.test(bg)) return color;
  const rgb = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const towardBlack = contrastRatio('#000000', bg) >= contrastRatio('#ffffff', bg);
  for (let step = 0; step <= 20; step++) {
    const f = step / 20;
    const mixed = rgb.map((c) => Math.round(towardBlack ? c * (1 - f) : c + (255 - c) * f));
    const hex = `#${mixed.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
    if (contrastRatio(hex, bg) >= 4.5) return hex;
  }
  return towardBlack ? '#000000' : '#ffffff';
}

export function contrastLabel(ratio: number): { tone: 'success' | 'warning'; text: string } {
  const r = `${ratio.toFixed(1).replace(/\.0$/, '')}:1`;
  if (ratio >= 7) return { tone: 'success', text: `AAA · ${r}` };
  if (ratio >= 4.5) return { tone: 'success', text: `AA · ${r}` };
  return { tone: 'warning', text: `Low on background · ${r}` };
}

export function BrandStylePage() {
  const { theme, isPending, isError, list } = useActiveTheme();
  if (isPending) return <LoadingState label="Loading brand style" />;
  if (isError || !theme.data) return <ErrorState onRetry={() => void Promise.all([list.refetch(), theme.refetch()])} />;
  return <BrandStyleEditor key={`${theme.data.code}:${theme.data.draft_revision}`} theme={theme.data} />;
}

function BrandStyleEditor({ theme }: { theme: StoreTheme }) {
  const canEdit = useCanEditStore();
  const store = useTenantStore().data!;
  const queryClient = useQueryClient();
  const def = getThemeDefinition(theme.code);
  const [state, dispatch] = useReducer(editorReducer, theme.draft_config, initEditor);
  const [revision, setRevision] = useState(theme.draft_revision);
  const [saved, setSaved] = useState(theme.draft_config);
  const [conflict, setConflict] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const s = state.config.settings;
  const dirty = JSON.stringify(state.config.settings) !== JSON.stringify(saved.settings);
  const changes = summarizeChanges(state.config, theme.published_config);

  const refresh = async (updated?: StoreTheme) => {
    if (updated) queryClient.setQueryData(osKeys.storeTheme(store.id, theme.code), updated);
    await queryClient.invalidateQueries({ queryKey: osKeys.storeThemes(store.id) });
  };

  const onError = (e: unknown) => {
    if (isApiError(e) && e.status === 409 && e.code === 'revision_conflict') setConflict(true);
    else toast(isApiError(e) ? e.message : 'Something went wrong. Try again.', 'error');
  };

  const saveDraft = useMutation({
    mutationFn: () => api.storeThemes.saveDraft(store.id, theme.code, { config: state.config, base_revision: revision }),
    onSuccess: (t) => {
      setRevision(t.draft_revision);
      setSaved(state.config);
      void refresh(t);
      toast('Draft saved. Buyers still see the live style.');
    },
    onError,
  });

  const publish = useMutation({
    mutationFn: async () => {
      let rev = revision;
      if (dirty) rev = (await api.storeThemes.saveDraft(store.id, theme.code, { config: state.config, base_revision: revision })).draft_revision;
      return api.storeThemes.publish(store.id, theme.code, { draft_revision: rev });
    },
    onSuccess: (t) => {
      void refresh(t);
      toast('Published. Your shop updates in a few seconds.');
    },
    onError,
  });

  const discard = useMutation({
    mutationFn: () => api.storeThemes.discard(store.id, theme.code),
    onSuccess: (t) => {
      setConfirmDiscard(false);
      void refresh(t);
    },
    onError: (e) => {
      setConfirmDiscard(false);
      onError(e);
    },
  });

  const reload = async () => {
    setConflict(false);
    await queryClient.invalidateQueries({ queryKey: osKeys.storeTheme(store.id, theme.code) });
  };

  const setGlobal = (key: keyof ThemeGlobalSettings & string, value: unknown) => canEdit && dispatch({ type: 'setGlobal', key, value });
  const busy = saveDraft.isPending || publish.isPending || discard.isPending;
  const pairing = def?.pairings.find((p) => p.body === s.fontFamily && p.heading === s.headingFontFamily);

  const colours: { key: 'primaryColor' | 'textColor' | 'secondaryColor' | 'backgroundColor'; label: string; hint: string }[] = [
    { key: 'primaryColor', label: 'Primary', hint: 'Buttons, links, prices' },
    { key: 'textColor', label: 'Text', hint: 'Headings and body' },
    { key: 'secondaryColor', label: 'Accent', hint: 'Sale badges, highlights' },
    { key: 'backgroundColor', label: 'Background', hint: 'Page background' },
  ];
  const accentLow = contrastRatio(s.secondaryColor, s.backgroundColor) < 4.5;

  return (
    <div className="flex flex-col gap-6 lg:gap-7">
      <OnlineStoreHeader title="Brand style" description="Logo, colours, fonts and shapes — set once, used by every page and theme." />
      {!canEdit && <ReadOnlyBanner />}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,560px)_minmax(0,1fr)] lg:gap-7">
        <div className="flex flex-col gap-5">
          <LogoAndIcons storeId={store.id} canEdit={canEdit} />

          <Panel title="Start from a style" description="Each one sets colours, fonts and corners together. You can tweak anything after.">
            <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {def?.presets.map((p) => {
                const active = s.stylePreset === p.id;
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      aria-pressed={active}
                      disabled={!canEdit}
                      onClick={() => dispatch({ type: 'applyPreset', preset: p, pairing: def.pairings.find((x) => x.id === p.pairing) })}
                      className={cn(
                        'flex w-full flex-col gap-2 rounded-lg bg-surface-card px-1.5 pt-1.5 pb-2.5 text-left outline-none focus-visible:shadow-focus disabled:cursor-not-allowed',
                        active ? 'shadow-[inset_0_0_0_2px_var(--color-brand-600)]' : 'shadow-[inset_0_0_0_1px_var(--color-border-default)]',
                      )}
                    >
                      <span className="flex flex-col gap-1.5 rounded-md p-2.5" style={{ backgroundColor: p.backgroundColor === '#ffffff' ? `${p.primaryColor}14` : p.backgroundColor }}>
                        <span className="text-[18px] leading-[22px] font-semibold" style={{ color: p.textColor }}>
                          Aa
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="h-2.5 w-[30px] rounded-full" style={{ backgroundColor: p.primaryColor }} />
                          <span className="size-2.5 rounded-full" style={{ backgroundColor: p.secondaryColor }} />
                        </span>
                      </span>
                      <span className={cn('pl-1 text-caption', active ? 'font-semibold text-text-primary' : 'text-text-secondary')}>{p.name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Panel>

          <Panel title="Colours" description="We check every pair so text stays readable on phones in sunlight.">
            <ul className="flex flex-col gap-4">
              {colours.map((c) => {
                const value = s[c.key];
                const ratio = c.key === 'backgroundColor' ? null : contrastRatio(value, s.backgroundColor);
                const label = ratio ? contrastLabel(ratio) : null;
                return (
                  <li key={c.key} className="flex flex-wrap items-center gap-3 pt-3 [&:not(:first-child)]:border-t [&:not(:first-child)]:border-border-default">
                    <label className="relative size-9 shrink-0 cursor-pointer overflow-hidden rounded-control border border-border-default" style={{ backgroundColor: value }}>
                      <span className="sr-only">{c.label} colour picker</span>
                      <input
                        type="color"
                        value={value}
                        disabled={!canEdit}
                        onChange={(e) => setGlobal(c.key, e.target.value.toLowerCase())}
                        className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
                      />
                    </label>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="text-body font-medium text-text-primary">{c.label}</span>
                      <span className="text-caption text-text-muted">{c.hint}</span>
                    </div>
                    <HexInput label={`${c.label} colour`} value={value} disabled={!canEdit} onChange={(v) => setGlobal(c.key, v)} />
                    <ContrastPill tone={label?.tone ?? 'neutral'}>{label?.text ?? '—'}</ContrastPill>
                  </li>
                );
              })}
            </ul>
            {accentLow && (
              <div className="flex flex-wrap items-center gap-2 rounded-control bg-warning-bg px-3 py-2.5 text-[12px] leading-[17px]">
                <p className="min-w-0 flex-1 text-text-primary">Accent text is hard to read on this background. We’ll use it for badges only, with dark text on top.</p>
                {canEdit && (
                  <button type="button" className="font-semibold text-warning hover:underline" onClick={() => setGlobal('secondaryColor', readableInk(s.secondaryColor, s.backgroundColor))}>
                    Fix for me
                  </button>
                )}
              </div>
            )}
          </Panel>

          <Panel title="Fonts" description="Pairs chosen to look right in English and বাংলা together.">
            <ul className="grid gap-2.5 sm:grid-cols-3">
              {def?.pairings.map((p) => {
                const active = pairing?.id === p.id;
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      aria-pressed={active}
                      disabled={!canEdit}
                      onClick={() => dispatch({ type: 'applyPairing', pairing: p })}
                      className={cn(
                        'flex h-full w-full flex-col gap-1.5 rounded-lg p-4 text-left whitespace-nowrap outline-none focus-visible:shadow-focus disabled:cursor-not-allowed',
                        active ? 'bg-brand-50 shadow-[inset_0_0_0_2px_var(--color-brand-600)]' : 'shadow-[inset_0_0_0_1px_var(--color-border-default)]',
                      )}
                    >
                      <span className="flex items-baseline gap-2 leading-7 text-text-primary">
                        <span className="text-[22px] font-semibold">Aa</span>
                        <span className="font-bangla text-[20px] font-semibold">অআ</span>
                      </span>
                      <span className="text-[13px] leading-[18px] font-semibold text-text-primary">{p.name}</span>
                      <span className="truncate text-[11px] leading-4 text-text-muted">{p.hint}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Panel>

          <Panel
            title="Corners & buttons"
            actions={
              <SegmentedControl
                size="sm"
                aria-label="Corners & buttons"
                disabled={!canEdit}
                value={s.cornerStyle}
                onChange={(v) => setGlobal('cornerStyle', v)}
                options={[
                  { value: 'square', label: 'Square' },
                  { value: 'rounded', label: 'Rounded' },
                  { value: 'pill', label: 'Pill' },
                ]}
              />
            }
          />
        </div>

        <StylePreview draft={s} live={theme.published_config?.settings ?? s} storeName={store.name} domain={storeDomain(store)} changed={changes.groups} />
      </div>

      {canEdit && (dirty || changes.groups.length > 0) && (
        <DraftBar
          title={`${changes.groups.length} change${changes.groups.length === 1 ? '' : 's'} in draft`}
          description="Buyers still see the live style until you publish"
          actions={
            <>
              <DraftBarGhostButton disabled={busy || !theme.published_config} onClick={() => setConfirmDiscard(true)}>
                Discard
              </DraftBarGhostButton>
              <Button variant="secondary" disabled={!dirty} loading={saveDraft.isPending} onClick={() => saveDraft.mutate()}>
                Save draft
              </Button>
              <Button loading={publish.isPending} disabled={busy} onClick={() => publish.mutate()}>
                Publish
              </Button>
            </>
          }
        />
      )}

      <Dialog
        open={confirmDiscard}
        tone="danger"
        title="Discard all unpublished changes?"
        description="Your theme goes back to what buyers see now. This also discards section edits made in the editor."
        confirmLabel="Discard changes"
        loading={discard.isPending}
        onConfirm={() => discard.mutate()}
        onCancel={() => setConfirmDiscard(false)}
      />
      <ConflictDialog open={conflict} onReload={() => void reload()} />
    </div>
  );
}

function HexInput({ label, value, onChange, disabled }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const [text, setText] = useState(value.toUpperCase());
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) {
      last.current = value;
      setText(value.toUpperCase());
    }
  }, [value]);
  const valid = HEX.test(text.toLowerCase());
  return (
    <input
      aria-label={label}
      aria-invalid={!valid || undefined}
      value={text}
      maxLength={7}
      disabled={disabled}
      onChange={(e) => {
        const v = e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}`;
        setText(v.toUpperCase());
        if (HEX.test(v.toLowerCase())) {
          last.current = v.toLowerCase();
          onChange(v.toLowerCase());
        }
      }}
      className={cn(
        'h-8 w-[82px] rounded-md border bg-surface-card px-2.5 text-[13px] leading-[18px] font-medium text-text-primary uppercase outline-none focus:border-brand-600 disabled:bg-surface-subtle',
        valid ? 'border-border-strong' : 'border-danger',
      )}
    />
  );
}

/** Logo & icons (P3-7): saved immediately through PATCH settings, "Saved, live now". */
function LogoAndIcons({ storeId, canEdit }: { storeId: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: settingsKey(storeId), queryFn: () => api.stores.getSettings(storeId) });
  const logo = useBrandUpload('logo');
  const favicon = useBrandUpload('favicon');
  const [picker, setPicker] = useState(false);
  const save = useMutation({
    mutationFn: (input: Parameters<typeof api.stores.updateSettings>[1]) => api.stores.updateSettings(storeId, input),
    onSuccess: (updated) => {
      queryClient.setQueryData(settingsKey(storeId), updated);
      toast('Saved, live now.');
    },
    onError: (e) => toast(isApiError(e) ? e.message : 'Could not save. Try again.', 'error'),
  });
  const data = settings.data;

  const tile = (kind: 'logo' | 'favicon' | 'share', label: string, hint: string, src: string | null | undefined, onReplace: () => void, busy: boolean, error?: string | null) => (
    <li className="flex flex-col gap-2.5 rounded-lg bg-surface-subtle p-3">
      <div className="flex h-16 items-center justify-center overflow-hidden rounded-md border border-border-default bg-surface-card">
        {busy ? <Spinner size="sm" label="Uploading" /> : src ? <img src={src} alt="" className={cn('max-h-full', kind === 'share' ? 'h-full w-full object-cover' : 'max-w-[80%] object-contain')} /> : <span className="text-caption text-text-muted">None yet</span>}
      </div>
      <div className="flex items-center justify-between gap-2 whitespace-nowrap">
        <div className="flex min-w-0 flex-col">
          <span className="text-[13px] leading-[18px] font-medium text-text-primary">{label}</span>
          <span className="truncate text-[11px] leading-4 text-text-muted">{hint}</span>
        </div>
        {canEdit && (
          <button type="button" onClick={onReplace} className="text-caption font-semibold text-brand-600 hover:underline">
            {src ? 'Replace' : 'Add'}
          </button>
        )}
      </div>
      {error && <p className="text-[11px] text-danger">{error}</p>}
    </li>
  );

  const pickFile = (accept: string, onFile: (f: File) => void) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => input.files?.[0] && onFile(input.files[0]);
    input.click();
  };

  return (
    <Panel title="Logo & icons" description="Shown in the header, browser tab and when the shop is shared.">
      {settings.isPending ? (
        <Spinner label="Loading" />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-3">
          {tile(
            'logo',
            'Logo',
            'PNG, JPG or WebP',
            data?.branding.logo?.url,
            () =>
              pickFile(logo.rule.accept, async (f) => {
                const r = await logo.upload(f);
                if (r) save.mutate({ branding: { logo_media_id: r.id } });
              }),
            logo.progress !== null || logo.processing,
            logo.error,
          )}
          {tile(
            'favicon',
            'Favicon',
            '64 × 64',
            data?.branding.favicon?.url,
            () =>
              pickFile(favicon.rule.accept, async (f) => {
                const r = await favicon.upload(f);
                if (r) save.mutate({ branding: { favicon_media_id: r.id } });
              }),
            favicon.progress !== null || favicon.processing,
            favicon.error,
          )}
          {tile('share', 'Share image', '1200 × 630', data?.seo?.share_image?.url, () => setPicker(true), false)}
        </ul>
      )}
      {picker && (
        <MediaPicker
          open
          title="Choose a share image"
          hint="1200 × 630 · landscape · JPG, PNG or WebP"
          currentId={data?.seo?.share_image?.id}
          onClose={() => setPicker(false)}
          onPick={(m) => save.mutate({ seo: { share_image_media_id: m.id } })}
        />
      )}
    </Panel>
  );
}

/** Figma 2035:46856 contrast pill: 11/16 semibold, px 8 py 2. */
function ContrastPill({ tone, children }: { tone: 'success' | 'warning' | 'neutral'; children: ReactNode }) {
  const tones = { success: 'bg-success-bg text-success', warning: 'bg-warning-bg text-warning', neutral: 'bg-surface-subtle text-text-muted' } as const;
  return <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] leading-4 font-semibold whitespace-nowrap', tones[tone])}>{children}</span>;
}

const previewProducts = [
  { name: 'Jamdani 3-Piece', price: '৳1,650', img: jamdani },
  { name: 'Silk Saree', price: '৳4,200', img: silk },
  { name: 'Cotton Panjabi', price: '৳1,250', img: panjabi },
  { name: 'Kids Kurti', price: '৳690', img: kurti },
];

/** Static preview card (Store preview 2035:46923) tinted with the draft (New) or published (Live) colours. */
function StylePreview({ draft, live, storeName, domain, changed }: { draft: ThemeGlobalSettings; live: ThemeGlobalSettings; storeName: string; domain: string; changed: string[] }) {
  const [version, setVersion] = useState<'live' | 'new'>('new');
  const [device, setDevice] = useState<'desktop' | 'phone'>('desktop');
  const s = version === 'live' ? live : draft;
  const radius = s.cornerStyle === 'square' ? 0 : s.cornerStyle === 'pill' ? 999 : 6;
  const phone = device === 'phone';
  return (
    <aside aria-label="Preview" className="flex flex-col gap-3 lg:sticky lg:top-6 lg:self-start">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="text-[15px] leading-[22px] font-semibold text-text-primary">Preview</h2>
          <p className="text-caption text-text-muted">Your real home page with these choices</p>
        </div>
        <SegmentedControl
          size="sm"
          aria-label="Preview version"
          value={version}
          onChange={setVersion}
          options={[
            { value: 'live', label: 'Live' },
            { value: 'new', label: 'New' },
          ]}
        />
        <SegmentedControl
          size="sm"
          aria-label="Preview device"
          value={device}
          onChange={setDevice}
          options={[
            { value: 'desktop', label: 'Desktop' },
            { value: 'phone', label: 'Phone' },
          ]}
        />
      </div>
      <div className="flex flex-col items-center gap-3.5 rounded-[20px] bg-[linear-gradient(160deg,var(--color-brand-50)_0%,var(--color-brand-100)_100%)] px-4 pt-6 pb-6 sm:px-6">
        <div
          className={cn('w-full overflow-hidden border border-border-default shadow-elevation-1', phone ? 'max-w-[240px] rounded-[20px]' : 'rounded-[10px]')}
          style={{ backgroundColor: s.backgroundColor, color: s.textColor }}
        >
          <div className="flex items-center gap-[7px] bg-surface-subtle px-3 py-2">
            {!phone && (
              <span aria-hidden className="flex gap-1.5">
                <span className="size-[7px] rounded-full bg-border-strong" />
                <span className="size-[7px] rounded-full bg-border-strong" />
                <span className="size-[7px] rounded-full bg-border-strong" />
              </span>
            )}
            <span className="flex min-w-0 items-center gap-1 rounded-md bg-surface-card px-2.5 py-[3px] text-[11px] leading-4 text-text-secondary">
              <Lock aria-hidden className="size-2.5 shrink-0" />
              <span className="truncate">{domain}</span>
            </span>
          </div>
          <div className="flex items-center gap-3 px-4 py-2.5">
            <span className="flex size-[18px] shrink-0 items-center justify-center rounded-[5px] text-[11px] font-medium text-text-inverse" style={{ backgroundColor: s.primaryColor }}>
              {storeName.charAt(0).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] leading-5 font-semibold" style={{ fontFamily: s.headingFontFamily }}>
              {storeName}
            </span>
            {!phone && (
              <span className="flex gap-3.5 text-[11px] leading-4 opacity-70">
                <span>New in</span>
                <span>Sarees</span>
                <span>Three-piece</span>
                <span>Panjabi</span>
              </span>
            )}
            <ShoppingCart aria-hidden className="size-4 shrink-0" />
          </div>
          <div className={cn('flex', phone ? 'flex-col-reverse' : 'h-[131px]')} style={{ backgroundColor: `${s.primaryColor}14` }}>
            <div className="flex min-w-0 flex-1 flex-col justify-center gap-1.5 px-5 py-3" style={{ fontFamily: s.fontFamily }}>
              <span className="text-[11px] leading-4 font-medium uppercase" style={{ color: s.primaryColor }}>
                Eid collection 2026
              </span>
              <span className="text-[17px] leading-7 font-semibold whitespace-nowrap" style={{ fontFamily: s.headingFontFamily }}>
                Jamdani, Katan & more
              </span>
              <span className="text-[11px] leading-4 opacity-80">Cash on delivery all over Bangladesh</span>
              <span className="flex items-center gap-2 pt-0.5">
                <span className="px-3 py-1.5 text-[11px] leading-4 font-medium text-text-inverse" style={{ backgroundColor: s.primaryColor, borderRadius: radius }}>
                  Shop now
                </span>
              </span>
            </div>
            <img src={silk} alt="" className={cn('object-cover', phone ? 'h-28 w-full' : 'h-full w-[47%]')} />
          </div>
          <ul className={cn('grid gap-2.5 px-4 py-3', phone ? 'grid-cols-2' : 'grid-cols-4')}>
            {previewProducts.slice(0, phone ? 2 : 4).map((p) => (
              <li key={p.name} className="flex min-w-0 flex-col gap-1">
                <img src={p.img} alt="" className="aspect-[101/91] w-full object-cover" style={{ borderRadius: Math.min(radius, 6) }} />
                <span className="truncate text-[11px] leading-4">{p.name}</span>
                <span className="text-[11px] leading-4 font-medium" style={{ color: s.primaryColor }}>
                  {p.price}
                </span>
              </li>
            ))}
          </ul>
        </div>
        {version === 'new' && changed.length > 0 && (
          <p className="flex flex-wrap items-center justify-center gap-1.5 text-caption font-medium text-text-secondary">
            Changed:
            {changed.map((g) => (
              <span key={g} className="rounded-full bg-surface-card px-2 py-0.5 text-[11px] leading-4 font-medium text-text-primary capitalize">
                {g}
              </span>
            ))}
          </p>
        )}
      </div>
    </aside>
  );
}
