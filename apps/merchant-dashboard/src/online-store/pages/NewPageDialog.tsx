import { isApiError } from '@storeplix/api-client';
import type { PageTemplate, PageTemplateCode, StorePage } from '@storeplix/types';
import { Button, Checkbox, cn, Input, Modal, Spinner, Toggle } from '@storeplix/ui';
import { useMutation } from '@tanstack/react-query';
import { Check, Plus } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { api } from '../../lib/api';
import { useTenantStore } from '../../stores/useTenantStore';
import { slugify } from '../lib/safeHref';
import { usePageTemplates, useStorePages } from '../hooks';
import { slugError } from './pageBlocks';

// Figma V3 New page dialog 2046:49298 (page 2046:48852). "Fill in with my shop's details" is always on in Phase 3
// (shown checked and disabled); "Also add to Footer menu" → add_to_menu: "footer".

type Category = 'all' | PageTemplate['category'];
const categories: { value: Category; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'help_policies', label: 'Help & policies' },
  { value: 'about', label: 'About the shop' },
  { value: 'selling', label: 'Selling' },
];

export function NewPageDialog({ initialTemplate, onClose, onCreated }: { initialTemplate: PageTemplateCode; onClose: () => void; onCreated: (page: StorePage) => void }) {
  const store = useTenantStore().data!;
  const templates = usePageTemplates();
  const pages = useStorePages();
  const [category, setCategory] = useState<Category>('all');
  const [code, setCode] = useState<PageTemplateCode>(initialTemplate);
  const [title, setTitle] = useState<string | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  const [addToFooter, setAddToFooter] = useState(true);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});

  const list = templates.data ?? [];
  const template = list.find((t) => t.code === code) ?? list[0];
  const name = title ?? template?.default_title ?? '';
  const link = slug ?? template?.default_slug ?? slugify(name);
  const taken = (pages.data?.data ?? []).map((p) => p.slug);
  const linkError = serverErrors.slug || (link ? slugError(link, taken) : null);
  const nameError = serverErrors.title || (name.trim() ? (name.length > 120 ? 'Use at most 120 characters.' : null) : 'Give the page a name.');

  const create = useMutation({
    mutationFn: () =>
      api.pages.create(store.id, {
        template: template!.code,
        title: name.trim(),
        ...(link ? { slug: link } : {}),
        add_to_menu: addToFooter ? 'footer' : null,
      }),
    onSuccess: onCreated,
    onError: (e) => {
      if (isApiError(e) && e.code === 'page_limit_reached') setServerErrors({ form: 'You’ve reached the 50-page limit. Delete a page to add a new one.' });
      else if (isApiError(e) && e.fieldErrors) setServerErrors({ title: e.fieldError('title') ?? '', slug: e.fieldError('slug') ?? '', form: e.fieldError('template') ?? '' });
      else setServerErrors({ form: 'Couldn’t create the page. Try again.' });
    },
  });

  const shown = list.filter((t) => category === 'all' || t.category === category || t.code === 'blank');

  return (
    <Modal
      open
      onClose={onClose}
      title="New page"
      description="Pick a starting point — every template is already written for Bangladeshi buyers."
      variant="v3"
      className="max-w-[924px]"
      footer={
        <>
          <span className="mr-auto hidden text-caption text-text-muted sm:block">Saved as a draft until you publish</span>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={create.isPending} disabled={!template || !!nameError || (!!link && !!slugError(link, taken))} onClick={() => create.mutate()}>
            Create page
          </Button>
        </>
      }
    >
      {templates.isPending ? (
        <div className="flex h-48 items-center justify-center">
          <Spinner label="Loading templates" />
        </div>
      ) : templates.isError ? (
        <p className="px-7 py-5 text-body text-text-secondary">We couldn’t load templates. Close this and try again.</p>
      ) : (
        <div className="grid md:grid-cols-[minmax(0,1fr)_320px]">
          <div className="flex flex-col gap-3 pt-5 pr-6 pb-6 pl-7">
            <div role="group" aria-label="Template category" className="flex flex-wrap gap-1.5">
              {categories.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  aria-pressed={category === c.value}
                  onClick={() => setCategory(c.value)}
                  className={cn(
                    'rounded-full px-3 py-[5px] text-caption font-medium outline-none focus-visible:shadow-focus',
                    category === c.value ? 'bg-text-primary text-text-inverse' : 'bg-surface-subtle text-text-secondary',
                  )}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <ul className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              {shown.map((t) => {
                const active = t.code === template?.code;
                return (
                  <li key={t.code}>
                    <button
                      type="button"
                      aria-pressed={active}
                      onClick={() => {
                        setCode(t.code);
                        setTitle(null);
                        setSlug(null);
                        setServerErrors({});
                      }}
                      className={cn(
                        'flex h-full w-full flex-col gap-2.5 rounded-[14px] px-2 pt-2 pb-3 text-left outline-none focus-visible:shadow-focus',
                        active ? 'bg-brand-50 shadow-[inset_0_0_0_2px_var(--color-brand-600)]' : 'bg-surface-card shadow-[inset_0_0_0_1px_var(--color-border-default)]',
                      )}
                    >
                      <TemplateSketch code={t.code} active={active} />
                      <span className="flex flex-col gap-0.5 px-1">
                        <span className="text-[13px] leading-[18px] font-semibold text-text-primary">{t.name}</span>
                        <span className="text-[11px] leading-[15px] text-text-muted">{t.description}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          {template && (
            <div className="flex flex-col gap-4 border-t border-border-default bg-surface-canvas pt-5 pr-7 pb-6 pl-6 md:border-t-0 md:border-l">
              <h3 className="text-[15px] leading-[22px] font-semibold text-text-primary">{/ page$/i.test(template.name) ? template.name : `${template.name} page`}</h3>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="new-page-name" className="text-caption font-medium text-text-secondary">
                  Page name
                </label>
                <Input id="new-page-name" value={name} maxLength={120} error={nameError ?? undefined} onChange={(e) => setTitle(e.target.value)} fieldClassName={fieldClass} className={inputClass} />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="new-page-link" className="text-caption font-medium text-text-secondary">
                  Link
                </label>
                <Input
                  id="new-page-link"
                  leading={<span className="text-[13px] leading-[18px] font-normal text-text-muted">/pages/</span>}
                  leadingDivider={false}
                  value={link}
                  maxLength={80}
                  hint={slug === null ? 'Made from the name — you can change it' : undefined}
                  error={linkError ?? undefined}
                  fieldClassName={fieldClass}
                  className={inputClass}
                  containerClassName="[&>p]:text-[11px] [&>p]:leading-4"
                  onChange={(e) => {
                    setSlug(e.target.value.toLowerCase());
                    setServerErrors((s) => ({ ...s, slug: '' }));
                  }}
                />
              </div>
              {template.highlights.length > 0 && (
                <div className="flex flex-col gap-2">
                  <span className="text-caption font-medium text-text-secondary">Comes with answers about</span>
                  <ul className="flex flex-col gap-2">
                    {template.highlights.map((h) => (
                      <li key={h} className="flex items-center gap-2 text-caption text-text-primary">
                        <Check aria-hidden className="size-3.5 shrink-0 text-success" strokeWidth={2.5} /> {h}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="flex items-center gap-3 rounded-lg bg-brand-50 p-3">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[13px] leading-[18px] font-semibold text-brand-700">✦ Fill in with my shop’s details</span>
                  <span className="text-[11px] leading-[15px] text-text-secondary">Uses your shop name, phone and email</span>
                </div>
                <Toggle label="Fill in with my shop’s details" checked disabled />
              </div>
              <Checkbox size="sm" label="Also add to Footer menu" checked={addToFooter} onChange={(e) => setAddToFooter(e.target.checked)} />
              {serverErrors.form && (
                <p role="alert" className="text-caption text-danger">
                  {serverErrors.form}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

const fieldClass = 'min-h-[38px] rounded-md border-border-strong';
const inputClass = 'py-[9px] text-[13px] leading-[18px]';

/** Figma 2046:49316 template thumbnails (160×96 sketches). */
function TemplateSketch({ code, active }: { code: PageTemplateCode; active: boolean }) {
  const bar = <span className="absolute top-2.5 left-3 h-1.5 w-[60px] rounded-[2px] bg-text-primary" />;
  const line = (top: number, w: number, extra = '') => <span key={top} className={cn('absolute left-3 rounded-[2px]', extra)} style={{ top, width: w }} />;
  let inner: ReactNode;
  switch (code) {
    case 'blank':
      inner = <Plus className="absolute top-9 left-[68px] size-6 text-text-muted" strokeWidth={1.5} />;
      break;
    case 'size_guide':
      inner = (
        <>
          {bar}
          {[26, 42, 58, 74].map((top, r) =>
            [12, 47, 82, 117].map((left) => <span key={`${top}-${left}`} className={cn('absolute h-3 w-[31px] rounded-[2px]', r === 0 ? 'bg-brand-100' : 'bg-surface-card')} style={{ top, left }} />),
          )}
        </>
      );
      break;
    case 'how_to_order':
      inner = (
        <>
          {bar}
          {[12, 60, 108].map((left) => (
            <span key={left}>
              <span className="absolute top-7 size-10 rounded-sm bg-surface-card" style={{ left }} />
              <span className="absolute top-[74px] h-1 w-3 rounded-[2px] bg-brand-600" style={{ left: left + 14 }} />
            </span>
          ))}
        </>
      );
      break;
    case 'wholesale':
    case 'contact':
      inner = (
        <>
          {bar}
          {[26, 44, 62].map((top) => line(top, 136, 'h-3 bg-surface-card'))}
          <span className="absolute top-20 left-3 h-2.5 w-[60px] rounded-[3px] bg-brand-600" />
        </>
      );
      break;
    case 'about':
      inner = (
        <>
          {bar}
          <span className="absolute top-6 left-3 h-[62px] w-16 rounded-sm bg-accent-100" />
          {[
            [28, 60],
            [38, 56],
            [48, 48],
          ].map(([top, w]) => (
            <span key={top} className="absolute left-[84px] h-1 rounded-[2px] bg-border-strong" style={{ top, width: w }} />
          ))}
        </>
      );
      break;
    default:
      inner = (
        <>
          {bar}
          {[26, 42, 58, 74].map((top) => (
            <span key={top}>
              <span className={cn('absolute left-3 h-[11px] w-[136px] rounded-[4px]', active ? 'bg-surface-subtle' : 'bg-surface-card')} style={{ top }} />
              <span className="absolute left-[18px] h-1 w-[70px] rounded-[2px] bg-border-strong" style={{ top: top + 3 }} />
            </span>
          ))}
        </>
      );
  }
  return (
    <span aria-hidden className={cn('relative block h-24 w-full overflow-hidden rounded-md', active ? 'bg-surface-card' : 'bg-surface-subtle')}>
      {inner}
    </span>
  );
}
