import { AI_CREDIT_COSTS, AI_PHOTO_BACKGROUNDS, type AiCreditsSummary, type AiGeneration, type AiIntegrationProvider, type AiLength, type AiPhotoBackground, type AiTone, type ProductDescriptionVariant } from '@storeplix/types';
import { Badge, Button, Chip, cn, Skeleton, Spinner } from '@storeplix/ui';
import { AlertTriangle, ChevronLeft, ChevronRight, ImageOff, Sparkles, Undo2 } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { ErrorBlock } from '../catalog/states';
import { formatDate } from '../plan/billing';
import {
  aiErrorText,
  backgroundLabel,
  backgroundSwatch,
  canUndo,
  creditsLeftLine,
  creditsLevel,
  creditWord,
  exhaustedDetails,
  exhaustedText,
  generationErrorText,
  hasCreditsFor,
  isWorking,
  LANGUAGES,
  languageLabel,
  LENGTHS,
  lengthLabel,
  parseKeyPoints,
  photoEditInput,
  resetsText,
  TONES,
  toneLabel,
  type AiLanguage,
} from './ai';
import { useAiCredits, useApplyPhoto, useDescribeProduct, useEditPhoto, useGeneration, useUndoPhoto } from './aiQueries';
import claudeLogo from './assets/claude.svg';
import { Panel } from './components';

// PHASE-8-9D part B shared AI pieces: the AI tile, the AI credits card (Figma 2135:55033 right column / 2142:58593),
// the low/out-of-credits banner (2142:58681), the "Write with AI" panel (2141:60490) and the photo editor "Try it"
// (2135:55033). Tokens only; output is plain text (never model HTML).

/** Claude: the Claude mark from Figma 31:5800 in a bordered tile; AI photos: the brand "AI" tile (2135:55033). */
export function AiTile({ provider, size = 'lg' }: { provider: AiIntegrationProvider; size?: 'md' | 'lg' }) {
  if (provider === 'ai_writer') {
    return (
      <span aria-hidden className={cn('flex shrink-0 items-center justify-center border border-border-default bg-surface-card', size === 'lg' ? 'size-12 rounded-card sm:size-16' : 'size-10 rounded-control')}>
        <img alt="" src={claudeLogo} className={size === 'lg' ? 'size-6 sm:size-8' : 'size-6'} />
      </span>
    );
  }
  return (
    <span aria-hidden className={cn('flex shrink-0 items-center justify-center bg-brand-600 font-semibold text-text-inverse', size === 'lg' ? 'size-12 rounded-card text-heading sm:size-16' : 'size-10 rounded-control text-body')}>
      AI
    </span>
  );
}

/** Right-column "AI credits" (shared with Claude and AI photos, resets monthly). */
export function AiCreditsCard() {
  const credits = useAiCredits();
  if (credits.isPending) return <Skeleton className="h-48 rounded-card" />;
  if (credits.isError) {
    return (
      <Panel title="AI credits">
        <ErrorBlock title="We couldn’t load your AI credits" error={credits.error} onRetry={() => void credits.refetch()} />
      </Panel>
    );
  }
  const c = credits.data;
  const limit = c.allowance.limit;
  const level = creditsLevel(c);
  const pct = limit ? Math.max(0, Math.min(100, ((c.allowance.remaining ?? 0) / limit) * 100)) : 100;
  return (
    <Panel title="AI credits" description={`Shared by Claude and AI product photos · ${resetsText(c.allowance.resets_at)}`}>
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-display font-semibold text-text-primary" data-testid="ai-credits-available">
          {c.available.toLocaleString('en-US')}
        </span>
        <span className="text-body text-text-secondary">{limit ? `of ${limit.toLocaleString('en-US')} left this month` : 'left'}</span>
      </p>
      <div role="meter" aria-label="Plan allowance left" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} className="h-2 overflow-hidden rounded-full bg-surface-subtle">
        <div className={cn('h-full rounded-full', level === 'ok' ? 'bg-brand-600' : level === 'low' ? 'bg-warning' : 'bg-danger')} style={{ width: `${pct}%` }} />
      </div>
      <dl className="flex flex-col gap-2.5 text-body">
        <div className="flex justify-between gap-3">
          <dt className="text-text-secondary">Plan allowance used</dt>
          <dd className="font-medium text-text-primary">
            {c.allowance.used.toLocaleString('en-US')}
            {limit ? ` of ${limit.toLocaleString('en-US')}` : ''}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-text-secondary">Bonus credits · never expire</dt>
          <dd className="font-medium text-text-primary">{c.bonus.toLocaleString('en-US')}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-text-secondary">Product description</dt>
          <dd className="font-medium text-text-primary">{creditWord(c.costs?.product_description ?? AI_CREDIT_COSTS.product_description)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-text-secondary">Photo edit</dt>
          <dd className="font-medium text-text-primary">{creditWord(c.costs?.photo_edit ?? AI_CREDIT_COSTS.photo_edit)}</dd>
        </div>
      </dl>
      <p className="text-caption text-text-muted">Failed edits and drafts are free. Undoing a saved photo doesn’t give credits back.</p>
      {level !== 'ok' && <CreditsBanner credits={c} />}
    </Panel>
  );
}

/** Danger banner when credits ran out, warning when ≤ 10 % is left. */
export function CreditsBanner({ credits, needed }: { credits: AiCreditsSummary; needed?: number }) {
  const out = credits.available <= 0 || (needed !== undefined && credits.available < needed);
  return (
    <p role={out ? 'alert' : 'status'} className={cn('flex items-start gap-2 rounded-control px-3.5 py-2.5 text-caption font-medium', out ? 'bg-danger-bg text-danger' : 'bg-warning-bg text-warning')}>
      <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>
        {out
          ? exhaustedText({ needed: needed ?? 1, available: credits.available, resets_at: credits.allowance.resets_at })
          : `Running low: ${creditWord(credits.available)} left. AI tools pause when credits run out; the rest of your shop keeps working.`}
      </span>
    </p>
  );
}

function ChipGroup<T extends string>({ label, values, value, labels, onChange, disabled }: { label: string; values: readonly T[]; value: T; labels: Record<T, string>; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-2">
      <span className="text-caption font-medium text-text-secondary">{label}</span>
      <div className="flex flex-wrap gap-2">
        {values.map((v) => (
          <Chip key={v} selected={v === value} check={false} disabled={disabled} onClick={() => onChange(v)} lang={v === 'bn' ? 'bn' : undefined}>
            {labels[v]}
          </Chip>
        ))}
      </div>
    </div>
  );
}

export interface WriterDefaults {
  tone: AiTone;
  length: AiLength;
  language: AiLanguage;
  useImage: boolean;
}

/**
 * "Write with AI" (Figma panel 2141:60490): key points, Tone / Length / Language chips, 1 credit per request (2 drafts),
 * queued → drafts (Previous / Next) → Insert below / Replace description / Try again. Nothing is saved here (P89D-52):
 * `onInsert` / `onReplace` fill the editor fields and the merchant saves the product.
 */
export function WriteWithAiPanel({
  productId,
  productName,
  defaults,
  onInsert,
  onReplace,
  onClose,
  insertLabel = 'Insert below',
}: {
  productId: string | null;
  productName: string;
  defaults: WriterDefaults;
  onInsert?: (v: ProductDescriptionVariant) => void;
  onReplace?: (v: ProductDescriptionVariant) => void;
  onClose?: () => void;
  insertLabel?: string;
}) {
  const idBase = useId();
  const [points, setPoints] = useState('');
  const [tone, setTone] = useState<AiTone>(defaults.tone);
  const [length, setLength] = useState<AiLength>(defaults.length);
  const [language, setLanguage] = useState<AiLanguage>(defaults.language);
  const [genId, setGenId] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [used, setUsed] = useState(0);
  const credits = useAiCredits();
  const describe = useDescribeProduct();
  const gen = useGeneration(genId);
  const g = gen.data ?? null;
  const cost = credits.data?.costs?.product_description ?? AI_CREDIT_COSTS.product_description;
  const exhausted = exhaustedDetails(describe.error);
  const out = (!!credits.data && !hasCreditsFor(credits.data, 'product_description')) || !!exhausted;
  const working = describe.isPending || (isWorking(g) && !gen.timedOut);
  const variants = g?.status === 'succeeded' || g?.status === 'applied' ? (g.variants ?? []) : [];
  const draft = variants[Math.min(index, variants.length - 1)];
  const needsName = !productId && !productName.trim();

  const generate = () => {
    if (needsName) return;
    describe.mutate(
      {
        ...(productId ? { product_id: productId } : { name: productName.trim() }),
        key_points: parseKeyPoints(points),
        tone,
        length,
        language,
        variants: 2,
        use_product_image: defaults.useImage,
      },
      {
        onSuccess: (created) => {
          setGenId(created.id);
          setIndex(0);
          setUsed((u) => u + created.credits);
        },
      },
    );
  };

  return (
    <section aria-label="Write with AI" className="flex flex-col gap-4 rounded-card border border-brand-100 bg-brand-50 p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2.5">
        <h3 className="text-body font-semibold text-text-primary">Write with AI</h3>
        <span className="text-caption text-text-secondary">
          Claude · {creditWord(cost)} per request
        </span>
        <span className="flex-1" />
        {onClose && (
          <button type="button" onClick={onClose} className="rounded-sm text-caption font-medium text-brand-600 outline-none hover:underline focus-visible:shadow-focus">
            Close
          </button>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${idBase}-points`} className="text-caption font-medium text-text-secondary">
          What should it mention? (optional)
        </label>
        <textarea
          id={`${idBase}-points`}
          aria-describedby={`${idBase}-points-hint`}
          rows={2}
          maxLength={2200}
          value={points}
          onChange={(e) => setPoints(e.target.value)}
          placeholder="e.g. half-silk, Eid, matching dupatta, hand wash only"
          className="rounded-control border border-border-default bg-surface-card px-3.5 py-2.5 text-body text-text-primary outline-none placeholder:text-text-muted focus:border-brand-600"
        />
        <span id={`${idBase}-points-hint`} className="text-caption text-text-muted">
          Separate points with commas or new lines · up to 10.
        </span>
      </div>
      <div className="flex flex-wrap gap-x-8 gap-y-3">
        <ChipGroup label="Tone" values={TONES} value={tone} labels={toneLabel} onChange={setTone} />
        <ChipGroup label="Length" values={LENGTHS} value={length} labels={lengthLabel} onChange={setLength} />
        <ChipGroup label="Language" values={LANGUAGES} value={language} labels={languageLabel} onChange={setLanguage} />
      </div>

      {needsName && <p className="text-caption text-warning">Add a product name first — Claude writes from it.</p>}
      {(out || exhausted) && credits.data && <CreditsBanner credits={exhausted ? { ...credits.data, available: exhausted.available } : credits.data} needed={exhausted?.needed ?? cost} />}
      {describe.error && !exhausted ? (
        <p role="alert" className="rounded-control bg-danger-bg px-3.5 py-2.5 text-caption text-danger">
          {aiErrorText(describe.error)}
        </p>
      ) : null}

      <div aria-live="polite" className="flex flex-col gap-2 rounded-lg bg-surface-card p-4">
        {working ? (
          <p className="flex items-center gap-2.5 text-body text-text-secondary">
            <Spinner label="Writing" className="size-4" /> Claude is writing two drafts… this takes a few seconds.
          </p>
        ) : gen.timedOut ? (
          <p className="text-body text-text-secondary">This is taking longer than usual. Try again — a draft that never arrives costs nothing.</p>
        ) : g?.status === 'failed' ? (
          <p role="alert" className="text-body text-danger">
            {generationErrorText(g.error_code)} Your credit was returned.
          </p>
        ) : gen.isError ? (
          <p role="alert" className="text-body text-danger">
            We couldn’t check on the draft. {aiErrorText(gen.error)}
          </p>
        ) : draft ? (
          <>
            <div className="flex flex-wrap items-center gap-2 text-caption text-text-secondary">
              <span>
                Draft {Math.min(index, variants.length - 1) + 1} of {variants.length} · {languageLabel[language]} · {toneLabel[tone].toLowerCase()} · {length}
              </span>
              <span className="flex-1" />
              {variants.length > 1 && (
                <>
                  <button type="button" disabled={index === 0} onClick={() => setIndex((i) => i - 1)} className="inline-flex items-center gap-0.5 font-medium text-brand-600 disabled:text-text-muted" aria-label="Previous draft">
                    <ChevronLeft aria-hidden className="size-3.5" /> Previous draft
                  </button>
                  <button type="button" disabled={index >= variants.length - 1} onClick={() => setIndex((i) => i + 1)} className="inline-flex items-center gap-0.5 font-medium text-brand-600 disabled:text-text-muted" aria-label="Next draft">
                    Next draft <ChevronRight aria-hidden className="size-3.5" />
                  </button>
                </>
              )}
            </div>
            <DraftText variant={draft} language={language} />
            <p className="text-caption text-text-muted">Check sizes and fabric before you save. AI can get details wrong, and nothing is published until you save the product.</p>
          </>
        ) : (
          <p className="text-body text-text-muted">Your drafts appear here. Pick one, then save the product as usual.</p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        {draft && !working ? (
          <>
            {onInsert && (
              <Button size="sm" onClick={() => onInsert(draft)}>
                {insertLabel}
              </Button>
            )}
            {onReplace && (
              <Button size="sm" variant="secondary" onClick={() => onReplace(draft)}>
                Replace description
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={out || needsName} loading={describe.isPending} onClick={generate}>
              Try again
            </Button>
          </>
        ) : (
          <Button size="sm" leftIcon={<Sparkles aria-hidden className="size-4" />} disabled={out || needsName || working} loading={describe.isPending} onClick={generate}>
            {gen.timedOut || g?.status === 'failed' ? 'Try again' : 'Write drafts'}
          </Button>
        )}
        <span className="flex-1" />
        {credits.data && (
          <span className="text-caption text-text-secondary" data-testid="ai-credits-line">
            {used > 0 ? `Used ${creditWord(used)} · ` : ''}
            {creditsLeftLine(credits.data)}
          </span>
        )}
      </div>
    </section>
  );
}

function DraftText({ variant, language }: { variant: ProductDescriptionVariant; language: AiLanguage }) {
  return (
    <div lang={language} className="flex flex-col gap-2 text-body-lg text-text-primary" data-testid="ai-draft">
      {variant.paragraphs.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
      {variant.highlights.length > 0 && (
        <ul className="flex list-disc flex-col gap-1 pl-5">
          {variant.highlights.map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ul>
      )}
      {(variant.seo_title || variant.meta_description) && (
        <div className="mt-1 flex flex-col gap-0.5 border-t border-border-default pt-2 text-caption text-text-secondary">
          {variant.seo_title && <span>Page title: {variant.seo_title}</span>}
          {variant.meta_description && <span>Search description: {variant.meta_description}</span>}
        </div>
      )}
    </div>
  );
}

// ---------- Photos ----------

export interface PhotoSource {
  media_id: string;
  url: string;
}

function PhotoBox({ label, url, pill, empty, busy }: { label: string; url: string | null; pill?: ReactNode; empty: string; busy?: boolean }) {
  return (
    <figure className="flex min-w-0 flex-1 flex-col gap-2">
      <div className="relative flex aspect-square items-center justify-center overflow-hidden rounded-lg border border-border-default bg-surface-canvas">
        {url ? <img src={url} alt={label} className="size-full object-contain" /> : busy ? <Spinner label="Editing photo" className="size-6" /> : <span className="px-4 text-center text-caption text-text-muted">{empty}</span>}
        {pill && <span className="absolute bottom-2 left-1/2 -translate-x-1/2">{pill}</span>}
      </div>
      <figcaption className="text-caption text-text-secondary">{label}</figcaption>
    </figure>
  );
}

/**
 * Photo "Try it" (Figma 2135:55033): choose a photo, a background preset, see before / after, then **Save to product**
 * (replaces that photo in place) and **Undo** while the original is kept (30 days). 2 credits per edit; failures free.
 */
export function AiPhotoEditor({
  productId,
  images,
  defaultBackground,
  canEdit,
  onApplied,
  title,
}: {
  productId: string;
  images: PhotoSource[];
  defaultBackground: AiPhotoBackground;
  canEdit: boolean;
  onApplied?: (g: AiGeneration) => void;
  title?: ReactNode;
}) {
  const [mediaId, setMediaId] = useState(images[0]?.media_id ?? '');
  const [background, setBackground] = useState<AiPhotoBackground>(defaultBackground);
  const [genId, setGenId] = useState<string | null>(null);
  const credits = useAiCredits();
  const edit = useEditPhoto();
  const apply = useApplyPhoto();
  const undo = useUndoPhoto();
  const gen = useGeneration(genId);
  const g = gen.data ?? null;
  const source = images.find((i) => i.media_id === mediaId) ?? images[0];
  const cost = credits.data?.costs?.photo_edit ?? AI_CREDIT_COSTS.photo_edit;
  const exhausted = exhaustedDetails(edit.error);
  const out = (!!credits.data && !hasCreditsFor(credits.data, 'photo_edit')) || !!exhausted;
  const working = edit.isPending || (isWorking(g) && !gen.timedOut);
  const result = g && (g.status === 'succeeded' || g.status === 'applied' || g.status === 'undone') ? g.result_image : null;
  const actionError = apply.error ?? undo.error;

  if (images.length === 0 || !source) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border-strong px-4 py-8 text-center">
        <ImageOff aria-hidden className="size-6 text-text-muted" />
        <p className="text-body text-text-secondary">Add a product photo first, then edit it here.</p>
      </div>
    );
  }

  const start = () =>
    edit.mutate(photoEditInput(source.media_id, productId, background), {
      onSuccess: (created) => setGenId(created.id),
    });
  const reset = () => {
    setGenId(null);
    edit.reset();
    apply.reset();
    undo.reset();
  };

  return (
    <div className="flex flex-col gap-4">
      {title}
      {images.length > 1 && !genId && (
        <div role="radiogroup" aria-label="Photo to edit" className="flex flex-wrap gap-2">
          {images.map((img, i) => (
            <button
              key={img.media_id}
              type="button"
              role="radio"
              aria-checked={img.media_id === source.media_id}
              aria-label={`Photo ${i + 1}`}
              onClick={() => setMediaId(img.media_id)}
              className={cn('size-14 overflow-hidden rounded-control border-2 outline-none focus-visible:shadow-focus', img.media_id === source.media_id ? 'border-brand-600' : 'border-transparent')}
            >
              <img src={img.url} alt="" className="size-full object-cover" />
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-4 sm:flex-row">
        <PhotoBox label="Original" url={source.url} empty="Original" />
        <PhotoBox
          label={g?.status === 'applied' ? 'Saved to product' : g?.status === 'undone' ? 'Undone — the original is back' : 'Edited'}
          url={result?.url ?? null}
          busy={working}
          empty={g?.status === 'failed' ? 'Edit failed' : 'Your edited photo appears here'}
          pill={
            result ? (
              <Badge tone="brand" size="sm">
                {backgroundLabel[background]}
              </Badge>
            ) : undefined
          }
        />
      </div>
      <div role="radiogroup" aria-label="Background" className="flex flex-wrap items-center gap-2">
        <span className="text-caption font-medium text-text-secondary">Background</span>
        {AI_PHOTO_BACKGROUNDS.map((b) => (
          <button
            key={b}
            type="button"
            role="radio"
            aria-checked={b === background}
            disabled={!!genId || !canEdit}
            onClick={() => setBackground(b)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-caption font-medium outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-60',
              b === background ? 'bg-brand-50 text-brand-700 shadow-[inset_0_0_0_1px_var(--color-brand-600)]' : 'bg-surface-card text-text-primary shadow-[inset_0_0_0_1px_var(--color-border-default)]',
            )}
          >
            <span aria-hidden className={cn('size-3.5 rounded-full border border-border-strong', backgroundSwatch[b])} />
            {backgroundLabel[b]}
          </button>
        ))}
      </div>

      {g?.status === 'succeeded' && g.check_edges && (
        <p role="status" className="flex items-start gap-2 rounded-control bg-warning-bg px-3.5 py-2.5 text-caption font-medium text-warning">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" /> Check the edges — hair, lace or see-through fabric may look rough. Try another background if it doesn’t look right.
        </p>
      )}
      {g?.status === 'failed' && (
        <p role="alert" className="rounded-control bg-danger-bg px-3.5 py-2.5 text-caption text-danger">
          {generationErrorText(g.error_code)} Failed edits are free — your credits were returned.
        </p>
      )}
      {gen.timedOut && <p className="text-caption text-text-secondary">This is taking longer than usual. Try again — an edit that never arrives costs nothing.</p>}
      {(out || exhausted) && credits.data && <CreditsBanner credits={exhausted ? { ...credits.data, available: exhausted.available } : credits.data} needed={exhausted?.needed ?? cost} />}
      {edit.error && !exhausted ? (
        <p role="alert" className="rounded-control bg-danger-bg px-3.5 py-2.5 text-caption text-danger">
          {aiErrorText(edit.error)}
        </p>
      ) : null}
      {actionError ? (
        <p role="alert" className="rounded-control bg-danger-bg px-3.5 py-2.5 text-caption text-danger">
          {aiErrorText(actionError)}
        </p>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <p className="min-w-0 flex-1 text-caption text-text-secondary">The product itself is never redrawn: colours, embroidery and fabric stay exactly as photographed.</p>
        {canEdit && (
          <div className="flex flex-col gap-2 sm:flex-row">
            {g?.status === 'applied' ? (
              canUndo(g) && (
                <Button variant="secondary" leftIcon={<Undo2 aria-hidden className="size-4" />} loading={undo.isPending} onClick={() => undo.mutate(g.id, { onSuccess: (r) => onApplied?.(r) })}>
                  Undo
                </Button>
              )
            ) : g?.status === 'succeeded' ? (
              <>
                <Button variant="secondary" onClick={reset} disabled={apply.isPending}>
                  Try another background
                </Button>
                <Button loading={apply.isPending} onClick={() => apply.mutate({ id: g.id, input: { product_id: productId, replace_image_id: source.media_id } }, { onSuccess: (r) => onApplied?.(r) })}>
                  Save to product
                </Button>
              </>
            ) : g && !working ? (
              <Button variant="secondary" onClick={reset}>
                {g.status === 'undone' ? 'Edit again' : 'Try again'}
              </Button>
            ) : (
              <Button disabled={out || working} loading={working} onClick={start}>
                Edit photo · {creditWord(cost)}
              </Button>
            )}
          </div>
        )}
      </div>
      {g?.status === 'applied' && g.original_kept_until && <p className="text-caption text-text-muted">Original kept until {formatDate(g.original_kept_until)} — you can undo until then.</p>}
    </div>
  );
}

