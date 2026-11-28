import { isApiError } from '@storeplix/api-client';
import { AI_PHOTO_BACKGROUNDS, type AiGeneration, type AiIntegrationProvider, type AiPhotoBackground, type AiPhotosSettings, type AiWriterSettings, type ProductDescriptionVariant, type StoreIntegration } from '@storeplix/types';
import { Badge, Button, Dialog, Input, Select, Skeleton, Toggle } from '@storeplix/ui';
import { AlertTriangle, Check, ChevronRight, Clock, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { useProduct, useProducts } from '../catalog/queries';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, StateCard } from '../catalog/states';
import { timeAgo } from '../commerce/format';
import { useReadOnly } from '../impersonation/hooks';
import { NoAccessState } from '../layout/RequirePermission';
import { toast } from '../online-store/components/Toast';
import { formatDate } from '../plan/billing';
import {
  AI_META,
  AI_PROVIDER_BY_SLUG,
  aiErrorText,
  backgroundLabel,
  canUndo,
  canUseAi,
  canViewAiPage,
  creditsCell,
  generationStatusMeta,
  LANGUAGES,
  languageLabel,
  LENGTHS,
  lengthLabel,
  photoEditLabel,
  TONES,
  toneLabel,
} from './ai';
import { AiCreditsCard, AiPhotoEditor, AiTile, WriteWithAiPanel } from './aiComponents';
import { useGenerations, useTurnOnAi, useUndoPhoto } from './aiQueries';
import { Columns, DetailTabs, Panel, SettingRow, TableCard, TableHead, tdClass, Tip } from './components';
import { parseTab } from './integrations';
import { useDisconnect, useIntegration, useUpdateSettings } from './queries';

// PHASE-8-9D §8 / §11 part B: `/integrations/claude` (ai_writer, Figma 31:5788) and `/integrations/ai-photos` (ai_photos,
// 2135:55033). Header with On/Off + type pills, "Turn off" in place of Disconnect (P89D-54; default Off, P89D-2).
// Tabs Overview · History · Settings (§8). Right column: AI credits (shared pool, §10), rules and a privacy tip.
// Hidden per §18 / Q364 / Q367: OpenAI / Gemini provider choice, "Edit photos in bulk", "Auto-edit new uploads", Claude
// features other than product descriptions (replies, order from chat, numbers), "Buy more credits".

type AiTab = 'overview' | 'history' | 'settings';
const AI_TABS: AiTab[] = ['overview', 'history', 'settings'];

const isOn = (row: Pick<StoreIntegration, 'status'> | undefined) => row?.status === 'connected' || row?.status === 'needs_attention';

export function AiToolPage({ slug }: { slug: string }) {
  const provider = AI_PROVIDER_BY_SLUG[slug];
  const { activeTenant } = useAuth();
  if (!provider) return <Navigate to="/integrations" replace />;
  if (!canViewAiPage(activeTenant)) return <NoAccessState heading={AI_META[provider].name} />;
  return <AiToolDetail key={provider} provider={provider} />;
}

function Breadcrumb({ provider }: { provider: AiIntegrationProvider }) {
  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-body font-medium">
      <Link to="/integrations" className="text-brand-600 hover:underline">
        Integrations
      </Link>
      <ChevronRight aria-hidden className="size-3.5 text-text-muted" />
      <Link to="/integrations?filter=ai" className="text-brand-600 hover:underline">
        AI for growth
      </Link>
      <ChevronRight aria-hidden className="size-3.5 text-text-muted" />
      <span aria-current="page" className="text-text-secondary">
        {AI_META[provider].name}
      </span>
    </nav>
  );
}

function AiToolDetail({ provider }: { provider: AiIntegrationProvider }) {
  const scope = useStoreScope();
  const { activeTenant } = useAuth();
  const readOnly = useReadOnly();
  const row = useIntegration(provider);
  const [params, setParams] = useSearchParams();
  const tab = parseTab<AiTab>(params.get('tab'), AI_TABS);
  const [turningOff, setTurningOff] = useState(false);
  const turnOn = useTurnOnAi(provider);
  const meta = AI_META[provider];
  const go = (t: AiTab) => {
    const p = new URLSearchParams(params);
    if (t === 'overview') p.delete('tab');
    else p.set('tab', t);
    setParams(p);
  };

  if (row.isPending) {
    return (
      <div className="flex flex-col gap-5" aria-busy="true" aria-label="Loading integration">
        <Breadcrumb provider={provider} />
        <Skeleton className="h-36 rounded-card" />
        <Skeleton className="h-96 rounded-card" />
      </div>
    );
  }
  if (row.isError) {
    // P89D-39: until an image provider is chosen the photos tool is not offered in production ("Coming soon").
    const comingSoon = provider === 'ai_photos' && isApiError(row.error) && (row.error.status === 404 || row.error.code === 'not_found');
    return (
      <div className="flex flex-col gap-5">
        <Breadcrumb provider={provider} />
        <StateCard>
          {comingSoon ? (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
              <Badge tone="info">Coming soon</Badge>
              <h1 className="text-heading text-text-primary">{meta.name}</h1>
              <p className="max-w-md text-body text-text-secondary">We’re choosing the image partner for clean product photos. You’ll be able to turn this on here soon.</p>
            </div>
          ) : (
            <ErrorBlock title={`We couldn’t load ${meta.name}`} error={row.error} onRetry={() => void row.refetch()} />
          )}
        </StateCard>
      </div>
    );
  }
  const data = row.data;
  const on = isOn(data);
  const manage = scope.canManageIntegrations && data.can.manage && !readOnly;
  const use = canUseAi(activeTenant) && !readOnly;
  const turnOnNow = () =>
    turnOn.mutate(
      { settings: (data.settings ?? data.defaults) as never, ...(data.status === 'not_connected' ? {} : { revision: data.revision }) },
      { onSuccess: () => toast(`${meta.name} is on`), onError: (e) => toast(aiErrorText(e), 'error') },
    );

  return (
    <div className="flex flex-col gap-5">
      <Breadcrumb provider={provider} />
      <section aria-label={meta.name} className="flex flex-col gap-4 rounded-card border border-border-default bg-surface-card px-4 py-[18px] shadow-elevation-1 lg:flex-row lg:items-center lg:gap-5 lg:px-6 lg:py-[22px]">
        <div className="flex min-w-0 flex-1 items-start gap-4 lg:items-center lg:gap-5">
          <AiTile provider={provider} />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-heading-24 font-semibold text-text-primary">{meta.name}</h1>
              <Badge tone={on ? 'success' : 'neutral'} dot={on} size="sm">
                {on ? 'On' : 'Off'}
              </Badge>
              <Badge tone="neutral" size="sm">
                {meta.typePill}
              </Badge>
            </div>
            <p className="text-body text-text-secondary">{meta.description}</p>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-text-secondary">
              {on && data.connected_at && (
                <li className="flex items-center gap-1.5">
                  <Check aria-hidden className="size-3.5 text-text-muted" />
                  Turned on {formatDate(data.connected_at)}
                  {data.connected_by ? ` by ${data.connected_by.name.split(' ')[0]}` : ''}
                </li>
              )}
              {on && data.last_verified_at && (
                <li className="flex items-center gap-1.5">
                  <Clock aria-hidden className="size-3.5 text-text-muted" />
                  Last used {timeAgo(data.last_verified_at)}
                </li>
              )}
              <li className="flex items-center gap-1.5">
                <ShieldCheck aria-hidden className="size-3.5 text-text-muted" />
                Using Storeplix AI credits
              </li>
            </ul>
          </div>
        </div>
        <div className="flex flex-col gap-2 lg:shrink-0 lg:items-end">
          {on ? (
            use && (
              <Button onClick={() => go('overview')} className="self-start lg:self-end">
                {provider === 'ai_photos' ? 'Try on a photo' : 'Try it'}
              </Button>
            )
          ) : manage ? (
            <Button loading={turnOn.isPending} onClick={turnOnNow} className="self-start lg:self-end">
              Turn on
            </Button>
          ) : null}
          {on && manage && (
            <button type="button" onClick={() => setTurningOff(true)} className="self-start rounded-sm text-body font-medium text-danger outline-none hover:underline focus-visible:shadow-focus lg:self-end">
              Turn off
            </button>
          )}
        </div>
      </section>
      {!scope.canManageIntegrations && <p className="rounded-md bg-surface-subtle px-3 py-2 text-body text-text-secondary">Only owners and managers can turn AI tools on or off.</p>}

      {!on ? (
        <Columns left={<OffCard provider={provider} manage={manage} loading={turnOn.isPending} onTurnOn={turnOnNow} error={turnOn.error} />} right={<RightColumn provider={provider} />} />
      ) : (
        <>
          <DetailTabs
            label={`${meta.name} sections`}
            value={tab}
            onChange={go}
            items={AI_TABS.map((t) => ({ value: t, label: t === 'overview' ? 'Overview' : t === 'history' ? meta.historyLabel : 'Settings' }))}
          />
          {tab === 'overview' && <Columns left={provider === 'ai_writer' ? <WriterTryIt row={data as StoreIntegration<'ai_writer'>} canUse={use} /> : <PhotosOverview row={data as StoreIntegration<'ai_photos'>} canUse={use} />} right={<RightColumn provider={provider} />} />}
          {tab === 'history' && <HistoryTable provider={provider} canUse={use} />}
          {tab === 'settings' && <Columns left={provider === 'ai_writer' ? <WriterSettingsCard row={data as StoreIntegration<'ai_writer'>} manage={manage} /> : <PhotoSettingsCard row={data as StoreIntegration<'ai_photos'>} manage={manage} />} right={<RightColumn provider={provider} />} />}
        </>
      )}

      {turningOff && <TurnOffDialog provider={provider} onClose={() => setTurningOff(false)} />}
    </div>
  );
}

function OffCard({ provider, manage, loading, onTurnOn, error }: { provider: AiIntegrationProvider; manage: boolean; loading: boolean; onTurnOn: () => void; error: unknown }) {
  const writer = provider === 'ai_writer';
  return (
    <Panel title={writer ? 'Write product descriptions with Claude' : 'Clean product photos with AI'} description="Off until you turn it on. Nothing is sent to an AI provider before that.">
      <ul className="flex flex-col gap-2.5">
        {(writer
          ? ['“Write with AI” appears in the product editor', 'Two drafts per request in Bangla or English, with an SEO title and description', 'You choose a draft; nothing is saved until you save the product', 'Sends only the product name, category, options, your notes and the main photo']
          : ['Remove the background or use a studio background', 'Before / after, then Save to product — undo for 30 days', 'The product itself is never redrawn', 'Sends only the photo you choose']
        ).map((t) => (
          <li key={t} className="flex items-start gap-2.5 text-body text-text-secondary">
            <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-success" /> {t}
          </li>
        ))}
      </ul>
      {error ? (
        <p role="alert" className="text-caption text-danger">
          {aiErrorText(error)}
        </p>
      ) : null}
      {manage ? (
        <Button className="self-start" loading={loading} onClick={onTurnOn}>
          Turn on
        </Button>
      ) : (
        <p className="text-caption text-text-muted">Ask your shop owner or a manager to turn it on.</p>
      )}
    </Panel>
  );
}

function RightColumn({ provider }: { provider: AiIntegrationProvider }) {
  return (
    <>
      <AiCreditsCard />
      {provider === 'ai_photos' && (
        <Panel title="Photo rules">
          <ul className="flex flex-col gap-2.5">
            {['JPG, PNG or WebP up to 10 MB', 'At least 300 px on the short side', 'One product per photo works best', 'People and faces are left as they are', 'No text or logos are added'].map((r) => (
              <li key={r} className="flex items-start gap-2 text-body text-text-secondary">
                <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-text-muted" /> {r}
              </li>
            ))}
          </ul>
        </Panel>
      )}
      <Tip title={provider === 'ai_photos' ? 'Your photos stay yours' : 'Your data stays yours'}>
        {provider === 'ai_photos'
          ? 'Photos are sent only for the edit you ask for, stored under your shop, and never used to train AI models.'
          : 'Only the product details needed for a draft are sent — never customer, order or cost data — and nothing is used to train models.'}
      </Tip>
    </>
  );
}

function WriterTryIt({ row, canUse }: { row: StoreIntegration<'ai_writer'>; canUse: boolean }) {
  const [name, setName] = useState('');
  const s = row.settings ?? row.defaults;
  const copy = (v: ProductDescriptionVariant) => {
    const text = [...v.paragraphs, ...v.highlights.map((h) => `• ${h}`)].join('\n');
    void navigator.clipboard?.writeText(text).then(
      () => toast('Draft copied'),
      () => toast('We couldn’t copy the draft', 'error'),
    );
  };
  return (
    <Panel title="Try it: product description" description="Describe a product here, or use “Write with AI” in the product editor to fill the description directly.">
      {canUse ? (
        <>
          <Input label="Product name" placeholder="e.g. Jamdani Three-Piece — Red" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
          <WriteWithAiPanel productId={null} productName={name} defaults={{ tone: s.default_tone, length: s.default_length, language: s.default_language, useImage: false }} onInsert={copy} insertLabel="Copy draft" />
        </>
      ) : (
        <p className="text-body text-text-secondary">Members who can edit products use Claude from the product editor.</p>
      )}
    </Panel>
  );
}

function PhotosOverview({ row, canUse }: { row: StoreIntegration<'ai_photos'>; canUse: boolean }) {
  const [productId, setProductId] = useState('');
  const products = useProducts({ per_page: 50, sort: '-updated_at' }, canUse);
  const product = useProduct(productId || undefined);
  const s = row.settings ?? row.defaults;
  const withImages = (products.data?.data ?? []).filter((p) => p.image);
  return (
    <>
      <Panel title={product.data ? `Try it: ${product.data.name}` : 'Try it'} description="Original kept for 30 days — you can undo any edit." actions={<Badge tone="neutral">2 credits per photo</Badge>}>
        {!canUse ? (
          <p className="text-body text-text-secondary">Members who can edit products edit photos here and in the product editor.</p>
        ) : products.isPending ? (
          <Skeleton className="h-11 rounded-control" />
        ) : products.isError ? (
          <ErrorBlock title="We couldn’t load your products" error={products.error} onRetry={() => void products.refetch()} />
        ) : withImages.length === 0 ? (
          <p className="text-body text-text-secondary">Add a product with a photo first, then try an edit here.</p>
        ) : (
          <>
            <Select label="Product" value={productId} onChange={(e) => setProductId(e.target.value)}>
              <option value="">Choose a product</option>
              {withImages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            {productId && product.isPending && <Skeleton className="h-64 rounded-lg" />}
            {product.isError && <ErrorBlock title="We couldn’t load this product" error={product.error} onRetry={() => void product.refetch()} />}
            {product.data && (
              <AiPhotoEditor
                key={product.data.id}
                productId={product.data.id}
                images={product.data.images.map((i) => ({ media_id: i.media_id, url: i.media.url }))}
                defaultBackground={s.default_background}
                canEdit
                onApplied={() => void product.refetch()}
              />
            )}
          </>
        )}
      </Panel>
      <HistoryTable provider="ai_photos" canUse={canUse} compact />
    </>
  );
}

function HistoryTable({ provider, canUse, compact = false }: { provider: AiIntegrationProvider; canUse: boolean; compact?: boolean }) {
  const kind = provider === 'ai_writer' ? 'product_description' : 'photo_edit';
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const list = useGenerations({ kind, cursor }, canUse);
  const undo = useUndoPhoto();
  const photos = kind === 'photo_edit';
  if (!canUse) return null;
  const rows = list.data?.data ?? [];
  return (
    <TableCard title={photos ? (compact ? 'Recent photo edits' : 'Photo history') : 'Description history'} description={compact ? undefined : 'Every AI request from this shop. Failed requests are free.'}>
      {list.isPending ? (
        <div className="px-6 pb-6">
          <Skeleton className="h-40 rounded-lg" />
        </div>
      ) : list.isError ? (
        <div className="px-6 pb-6">
          <ErrorBlock title="We couldn’t load the history" error={list.error} onRetry={() => void list.refetch()} />
        </div>
      ) : rows.length === 0 ? (
        <p className="px-6 pb-6 text-body text-text-muted">{photos ? 'No photo edits yet. Try one above.' : 'No drafts yet. Use “Write with AI” in the product editor.'}</p>
      ) : (
        <>
          <table className="w-full min-w-[640px] border-collapse">
            <TableHead cols={[{ label: 'Product' }, { label: photos ? 'Edit' : 'Request' }, { label: 'Credits' }, { label: 'By' }, { label: 'Status' }, { label: 'When' }]} />
            <tbody>
              {rows.map((g) => (
                <HistoryRow key={g.id} g={g} onUndo={photos && canUndo(g) ? () => undo.mutate(g.id, { onSuccess: () => toast('Original photo restored'), onError: (e) => toast(aiErrorText(e), 'error') }) : undefined} undoing={undo.isPending && undo.variables === g.id} />
              ))}
            </tbody>
          </table>
          {(list.data?.meta.next_cursor || cursor) && !compact && (
            <div className="flex gap-2 px-6 py-3">
              {cursor && (
                <Button size="sm" variant="secondary" onClick={() => setCursor(undefined)}>
                  Newest
                </Button>
              )}
              {list.data?.meta.next_cursor && (
                <Button size="sm" variant="secondary" onClick={() => setCursor(list.data.meta.next_cursor ?? undefined)}>
                  Older
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </TableCard>
  );
}

function HistoryRow({ g, onUndo, undoing }: { g: AiGeneration; onUndo?: () => void; undoing: boolean }) {
  const st = generationStatusMeta(g);
  const input = g.input as { tone?: string; language?: 'bn' | 'en'; name?: string | null };
  return (
    <tr>
      <td className={tdClass}>
        {g.product ? (
          <Link to={`/products/${g.product.id}`} className="font-medium text-text-primary hover:underline">
            {g.product.name}
          </Link>
        ) : (
          <span className="text-text-primary">{input.name ?? '—'}</span>
        )}
      </td>
      <td className={tdClass}>{g.kind === 'photo_edit' ? photoEditLabel(g) : `Description${input.language ? ` · ${languageLabel[input.language]}` : ''}${g.variants ? ` · ${g.variants.length} drafts` : ''}`}</td>
      <td className={tdClass}>{creditsCell(g)}</td>
      <td className={tdClass}>{g.requested_by?.name.split(' ')[0] ?? '—'}</td>
      <td className={tdClass}>
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone={st.tone} size="sm">
            {st.label}
          </Badge>
          {onUndo && (
            <Button size="sm" variant="ghost" loading={undoing} onClick={onUndo}>
              Undo
            </Button>
          )}
        </span>
      </td>
      <td className={tdClass}>{timeAgo(g.created_at)}</td>
    </tr>
  );
}

function WriterSettingsCard({ row, manage }: { row: StoreIntegration<'ai_writer'>; manage: boolean }) {
  const save = useUpdateSettings('ai_writer');
  const s = row.settings ?? row.defaults;
  const patch = (settings: Partial<AiWriterSettings>) => save.mutate({ settings, revision: row.revision }, { onSuccess: () => toast('Saved'), onError: (e) => toast(aiErrorText(e), 'error') });
  return (
    <Panel title="Writing settings" description="Defaults for “Write with AI”. You can change them for each draft.">
      <div>
        <SettingRow
          title="Language"
          control={
            <Select aria-label="Default language" value={s.default_language} disabled={!manage || save.isPending} onChange={(e) => patch({ default_language: e.target.value as AiWriterSettings['default_language'] })}>
              {LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {languageLabel[l]}
                </option>
              ))}
            </Select>
          }
        />
        <SettingRow
          title="Tone"
          control={
            <Select aria-label="Default tone" value={s.default_tone} disabled={!manage || save.isPending} onChange={(e) => patch({ default_tone: e.target.value as AiWriterSettings['default_tone'] })}>
              {TONES.map((t) => (
                <option key={t} value={t}>
                  {toneLabel[t]}
                </option>
              ))}
            </Select>
          }
        />
        <SettingRow
          title="Length"
          control={
            <Select aria-label="Default length" value={s.default_length} disabled={!manage || save.isPending} onChange={(e) => patch({ default_length: e.target.value as AiWriterSettings['default_length'] })}>
              {LENGTHS.map((l) => (
                <option key={l} value={l}>
                  {lengthLabel[l]}
                </option>
              ))}
            </Select>
          }
        />
        <SettingRow
          title="Use the main product photo"
          description="Claude looks at the cover photo for colour and details. Off: text only."
          control={<Toggle label="Use the main product photo" checked={s.use_product_image} disabled={!manage || save.isPending} onChange={(v) => patch({ use_product_image: v })} />}
        />
        <SettingRow title="Model" description="Chosen by Storeplix and billed in AI credits." control={<span className="text-body text-text-secondary">Claude (Anthropic)</span>} />
      </div>
    </Panel>
  );
}

function PhotoSettingsCard({ row, manage }: { row: StoreIntegration<'ai_photos'>; manage: boolean }) {
  const save = useUpdateSettings('ai_photos');
  const s = row.settings ?? row.defaults;
  const patch = (settings: Partial<AiPhotosSettings>) => save.mutate({ settings, revision: row.revision }, { onSuccess: () => toast('Saved'), onError: (e) => toast(aiErrorText(e), 'error') });
  return (
    <Panel title="Photo settings">
      <div>
        <SettingRow title="AI provider" description="Storeplix AI uses your AI credits." control={<span className="text-body text-text-secondary">Storeplix AI</span>} />
        <SettingRow
          title="Default background"
          description="Selected first when you edit a photo."
          control={
            <Select aria-label="Default background" value={s.default_background} disabled={!manage || save.isPending} onChange={(e) => patch({ default_background: e.target.value as AiPhotoBackground })}>
              {AI_PHOTO_BACKGROUNDS.map((b) => (
                <option key={b} value={b}>
                  {backgroundLabel[b]}
                </option>
              ))}
            </Select>
          }
        />
        <SettingRow title={`Keep originals for ${s.keep_originals_days} days`} description="Lets you undo. Originals count towards your storage." control={<Toggle label="Keep originals" checked disabled />} />
      </div>
    </Panel>
  );
}

function TurnOffDialog({ provider, onClose }: { provider: AiIntegrationProvider; onClose: () => void }) {
  const off = useDisconnect(provider);
  const meta = AI_META[provider];
  return (
    <Dialog
      open
      size="sm"
      tone="danger"
      icon={<AlertTriangle />}
      title={`Turn off ${meta.name}?`}
      description={provider === 'ai_writer' ? '“Write with AI” disappears from the product editor. Descriptions you already saved stay as they are.' : 'Photo editing stops. Saved photos stay on your products; undo stays available while originals are kept.'}
      confirmLabel="Turn off"
      cancelLabel="Keep on"
      loading={off.isPending}
      onCancel={() => !off.isPending && onClose()}
      onConfirm={() =>
        off.mutate(undefined, {
          onSuccess: () => {
            toast(`${meta.name} is off`);
            onClose();
          },
          onError: (e) => toast(aiErrorText(e), 'error'),
        })
      }
    />
  );
}

export default AiToolPage;
