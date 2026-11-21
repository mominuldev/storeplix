import { isApiError } from '@storeplix/api-client';
import type { PageTemplate, PageTemplateCode, StorePage } from '@storeplix/types';
import { Button, Checkbox, cn, Input, Modal, Spinner, Toggle } from '@storeplix/ui';
import { useMutation } from '@tanstack/react-query';
import { Check, Plus, Sparkles } from 'lucide-react';
import { useState } from 'react';
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
      else if (isApiError(e) && e.details) setServerErrors({ title: e.fieldError('title') ?? '', slug: e.fieldError('slug') ?? '', form: e.fieldError('template') ?? '' });
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
        <p className="text-body text-text-secondary">We couldn’t load templates. Close this and try again.</p>
      ) : (
        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_280px]">
          <div className="flex flex-col gap-4">
            <div role="group" aria-label="Template category" className="flex flex-wrap gap-1.5">
              {categories.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  aria-pressed={category === c.value}
                  onClick={() => setCategory(c.value)}
                  className={cn('rounded-full px-3 py-1 text-caption font-medium outline-none focus-visible:shadow-focus', category === c.value ? 'bg-text-primary text-text-inverse' : 'bg-surface-subtle text-text-secondary')}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <ul className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              {shown.map((t) => (
                <li key={t.code}>
                  <button
                    type="button"
                    aria-pressed={t.code === template?.code}
                    onClick={() => {
                      setCode(t.code);
                      setTitle(null);
                      setSlug(null);
                      setServerErrors({});
                    }}
                    className={cn(
                      'flex h-full w-full flex-col gap-2 rounded-lg bg-surface-card p-2 text-left outline-none focus-visible:shadow-focus',
                      t.code === template?.code ? 'bg-brand-50 shadow-[inset_0_0_0_1.5px_var(--color-brand-600)]' : 'shadow-[inset_0_0_0_1px_var(--color-border-default)]',
                    )}
                  >
                    <span aria-hidden className="flex h-20 items-center justify-center rounded-md bg-surface-subtle">
                      {t.code === 'blank' ? (
                        <Plus className="size-6 text-text-muted" />
                      ) : (
                        <span className="flex w-3/4 flex-col gap-1.5 rounded-sm bg-surface-card p-2">
                          <span className="h-1 w-1/2 rounded-full bg-text-primary" />
                          <span className="h-1 w-full rounded-full bg-border-strong" />
                          <span className="h-1 w-4/5 rounded-full bg-border-strong" />
                        </span>
                      )}
                    </span>
                    <span className="px-1 text-body font-semibold text-text-primary">{t.name}</span>
                    <span className="px-1 text-caption text-text-muted">{t.description}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          {template && (
            <div className="flex flex-col gap-4 border-t border-border-default pt-4 md:border-t-0 md:border-l md:pt-0 md:pl-6">
              <h3 className="text-body-lg font-semibold text-text-primary">{template.name}</h3>
              <Input label="Page name" value={name} maxLength={120} error={nameError ?? undefined} onChange={(e) => setTitle(e.target.value)} />
              <Input
                label="Link"
                leading={<span className="text-body text-text-muted">/pages/</span>}
                value={link}
                maxLength={80}
                hint={slug === null ? 'Made from the name — you can change it' : undefined}
                error={linkError ?? undefined}
                onChange={(e) => {
                  setSlug(e.target.value.toLowerCase());
                  setServerErrors((s) => ({ ...s, slug: '' }));
                }}
              />
              {template.highlights.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-caption font-medium text-text-secondary">Comes with answers about</span>
                  <ul className="flex flex-col gap-1">
                    {template.highlights.map((h) => (
                      <li key={h} className="flex items-center gap-2 text-body text-text-primary">
                        <Check aria-hidden className="size-4 text-success" /> {h}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="flex items-start gap-3 rounded-lg bg-brand-50 p-3">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-1 text-body font-semibold text-brand-700">
                    <Sparkles aria-hidden className="size-3.5" /> Fill in with my shop’s details
                  </span>
                  <span className="text-caption text-text-secondary">Uses your shop name, phone and email</span>
                </div>
                <Toggle label="Fill in with my shop’s details" checked disabled />
              </div>
              <Checkbox label="Also add to Footer menu" checked={addToFooter} onChange={(e) => setAddToFooter(e.target.checked)} />
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
