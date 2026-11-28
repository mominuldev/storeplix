import { zodResolver } from '@hookform/resolvers/zod';
import { isApiError } from '@storeplix/api-client';
import { HELP_CATEGORY_ICONS, HELP_LIMITS, HELP_SLUG_PATTERN, type AdminHelpCategory, type HelpCategoryIcon } from '@storeplix/types';
import { Button, Dialog, Drawer, Input, SortableList, cn, gripProps } from '@storeplix/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, FolderOpen, GripVertical, Pencil, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { Empty, ErrorState, LoadingRows } from '../components/States';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { useToast } from '../lib/toast';
import { slugify } from './doc';
import { HELP_ICON } from './format';
import { helpKeys, useHelpCategories } from './queries';

const optional = (max: number, label: string) => z.string().trim().max(max, `Keep the ${label} under ${max} characters`);
const schema = z.object({
  name_en: z.string().trim().min(1, 'Enter an English name').max(HELP_LIMITS.categoryName, `Keep the name under ${HELP_LIMITS.categoryName} characters`),
  name_bn: optional(HELP_LIMITS.categoryName, 'name'),
  slug: z.string().trim().min(1, 'Enter a slug').max(60, 'Keep the slug under 60 characters').regex(HELP_SLUG_PATTERN, 'Use lowercase letters, numbers and single dashes'),
  description_en: optional(HELP_LIMITS.categoryDescription, 'description'),
  description_bn: optional(HELP_LIMITS.categoryDescription, 'description'),
  icon: z.enum(HELP_CATEGORY_ICONS as [HelpCategoryIcon, ...HelpCategoryIcon[]]),
});
type Values = z.infer<typeof schema>;

function CategoryForm({ category, onDone, onCancel }: { category: AdminHelpCategory | null; onDone: () => void; onCancel: () => void }) {
  const formId = useId();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { register, handleSubmit, formState, setValue, setError, control, getFieldState } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name_en: category?.name_en ?? '',
      name_bn: category?.name_bn ?? '',
      slug: category?.slug ?? '',
      description_en: category?.description_en ?? '',
      description_bn: category?.description_bn ?? '',
      icon: category?.icon ?? 'rocket',
    },
  });
  const save = useMutation({
    mutationFn: (v: Values) => {
      const body = {
        slug: v.slug,
        name_en: v.name_en,
        name_bn: v.name_bn || null,
        description_en: v.description_en || null,
        description_bn: v.description_bn || null,
        icon: v.icon,
      };
      return category ? api.admin.help.categories.update(category.id, { ...body, revision: category.revision }) : api.admin.help.categories.create(body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: helpKeys.categories });
      toast(category ? 'Category saved' : 'Category added');
      onDone();
    },
    onError: (e) => {
      if (isApiError(e) && e.code === 'help_category_slug_taken') setError('slug', { message: errorMessage(e) });
    },
  });
  const name = register('name_en');

  return (
    <Dialog
      open
      title={category ? 'Edit category' : 'Add category'}
      confirmLabel={category ? 'Save' : 'Add category'}
      formId={formId}
      loading={save.isPending}
      onConfirm={() => undefined}
      onCancel={onCancel}
    >
      <form id={formId} noValidate className="flex flex-col gap-4" onSubmit={handleSubmit((v) => save.mutate(v))}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Name (English)"
            error={formState.errors.name_en?.message}
            {...name}
            onChange={(e) => {
              void name.onChange(e);
              if (!category && !getFieldState('slug').isDirty) setValue('slug', slugify(e.target.value, 60));
            }}
          />
          <Input label="Name (বাংলা)" error={formState.errors.name_bn?.message} {...register('name_bn')} />
        </div>
        <Input label="Slug" error={formState.errors.slug?.message} {...register('slug')} />
        <Input label="Description (English)" hint="Shown on the topic card, up to 160 characters" error={formState.errors.description_en?.message} {...register('description_en')} />
        <Input label="Description (বাংলা)" error={formState.errors.description_bn?.message} {...register('description_bn')} />
        <Controller
          control={control}
          name="icon"
          render={({ field }) => (
            <fieldset className="flex flex-col gap-2">
              <legend className="pb-2 text-body font-medium text-text-primary">Icon</legend>
              <div role="radiogroup" aria-label="Icon" className="flex flex-wrap gap-2">
                {HELP_CATEGORY_ICONS.map((icon) => {
                  const Icon = HELP_ICON[icon];
                  const on = field.value === icon;
                  return (
                    <button
                      key={icon}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      aria-label={icon}
                      onClick={() => field.onChange(icon)}
                      className={cn(
                        'flex size-10 items-center justify-center rounded-md border outline-none focus-visible:shadow-focus',
                        on ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-border-default text-text-secondary hover:bg-surface-subtle',
                      )}
                    >
                      <Icon aria-hidden className="size-[18px]" />
                    </button>
                  );
                })}
              </div>
            </fieldset>
          )}
        />
        {save.isError && !(isApiError(save.error) && save.error.code === 'help_category_slug_taken') && (
          <p role="alert" className="text-body text-danger">
            {errorMessage(save.error)}
          </p>
        )}
      </form>
    </Dialog>
  );
}

// Categories drawer (PHASE-8-9C §14, composed): rows with icon, names en/bn, counts, drag (or arrows) to reorder,
// add / edit / delete — delete is disabled with a tooltip while the category has articles (409 otherwise).
export function CategoriesDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const categories = useHelpCategories(open);
  const [editing, setEditing] = useState<AdminHelpCategory | 'new' | null>(null);
  const [deleting, setDeleting] = useState<AdminHelpCategory | null>(null);

  const reorder = useMutation({
    mutationFn: (ids: string[]) => api.admin.help.categories.reorder(ids),
    onMutate: async (ids) => {
      await queryClient.cancelQueries({ queryKey: helpKeys.categories });
      const previous = queryClient.getQueryData<AdminHelpCategory[]>(helpKeys.categories);
      if (previous) queryClient.setQueryData(helpKeys.categories, ids.map((id) => previous.find((c) => c.id === id)!).filter(Boolean));
      return { previous };
    },
    onError: (e, _ids, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(helpKeys.categories, ctx.previous);
      toast(errorMessage(e), 'danger');
    },
    onSuccess: (rows) => queryClient.setQueryData(helpKeys.categories, rows),
  });
  const remove = useMutation({
    mutationFn: (c: AdminHelpCategory) => api.admin.help.categories.delete(c.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: helpKeys.categories });
      toast('Category deleted');
      setDeleting(null);
    },
  });

  const rows = categories.data ?? [];
  const move = (from: number, to: number) => {
    if (to < 0 || to >= rows.length || from === to) return;
    const ids = rows.map((c) => c.id);
    const [id] = ids.splice(from, 1);
    ids.splice(to, 0, id!);
    reorder.mutate(ids);
  };

  return (
    <>
      <Drawer
        open={open && !editing && !deleting}
        onClose={onClose}
        title="Categories"
        description={categories.data ? `${rows.length} of ${HELP_LIMITS.categories} · drag to reorder the Help home` : undefined}
        width={480}
        footer={
          <Button onClick={() => setEditing('new')} disabled={rows.length >= HELP_LIMITS.categories}>
            Add category
          </Button>
        }
      >
        {categories.isPending ? (
          <LoadingRows label="Loading categories" rows={4} />
        ) : categories.isError ? (
          <ErrorState error={categories.error} onRetry={() => void categories.refetch()} />
        ) : rows.length === 0 ? (
          <Empty icon={<FolderOpen />} title="No categories yet" description="Articles need a category. Add the topics merchants will browse." />
        ) : (
          <SortableList
            label="Help categories"
            items={rows}
            onMove={move}
            disabled={reorder.isPending}
            className="p-3"
            renderItem={(c, { handle, index }) => {
              const Icon = HELP_ICON[c.icon];
              const busy = c.article_counts.total > 0;
              return (
                <div className="flex items-center gap-2 rounded-md border border-border-default bg-surface-card px-2 py-2.5">
                  <button type="button" aria-label={`Drag ${c.name_en}`} className="cursor-grab rounded-sm p-1 text-text-muted outline-none focus-visible:shadow-focus" {...gripProps(handle)}>
                    <GripVertical aria-hidden className="size-4" />
                  </button>
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-brand-50 text-brand-600">
                    <Icon aria-hidden className="size-4" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-body font-medium text-text-primary">{c.name_en}</span>
                    <span className="truncate text-caption text-text-muted">
                      {c.name_bn ?? 'বাংলা name missing'} · {c.article_counts.published} published · {c.article_counts.total} total
                    </span>
                  </span>
                  <button type="button" aria-label={`Move ${c.name_en} up`} disabled={index === 0 || reorder.isPending} onClick={() => move(index, index - 1)} className="rounded-sm p-1 text-text-muted outline-none hover:bg-surface-subtle focus-visible:shadow-focus disabled:opacity-30">
                    <ArrowUp aria-hidden className="size-4" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${c.name_en} down`}
                    disabled={index === rows.length - 1 || reorder.isPending}
                    onClick={() => move(index, index + 1)}
                    className="rounded-sm p-1 text-text-muted outline-none hover:bg-surface-subtle focus-visible:shadow-focus disabled:opacity-30"
                  >
                    <ArrowDown aria-hidden className="size-4" />
                  </button>
                  <button type="button" aria-label={`Edit ${c.name_en}`} onClick={() => setEditing(c)} className="rounded-sm p-1 text-text-secondary outline-none hover:bg-surface-subtle focus-visible:shadow-focus">
                    <Pencil aria-hidden className="size-4" />
                  </button>
                  <span title={busy ? 'Move or archive its articles first' : undefined}>
                    <button
                      type="button"
                      aria-label={`Delete ${c.name_en}`}
                      disabled={busy}
                      onClick={() => setDeleting(c)}
                      className="rounded-sm p-1 text-danger outline-none hover:bg-danger-bg focus-visible:shadow-focus disabled:text-text-muted disabled:opacity-40"
                    >
                      <Trash2 aria-hidden className="size-4" />
                    </button>
                  </span>
                </div>
              );
            }}
          />
        )}
      </Drawer>
      {editing && <CategoryForm category={editing === 'new' ? null : editing} onDone={() => setEditing(null)} onCancel={() => setEditing(null)} />}
      {deleting && (
        <Dialog
          open
          tone="danger"
          title={`Delete “${deleting.name_en}”?`}
          description="The topic disappears from Help. This can’t be undone."
          confirmLabel="Delete category"
          loading={remove.isPending}
          onConfirm={() => remove.mutate(deleting)}
          onCancel={() => {
            remove.reset();
            setDeleting(null);
          }}
        >
          {remove.isError && (
            <p role="alert" className="text-body text-danger">
              {errorMessage(remove.error)}
            </p>
          )}
        </Dialog>
      )}
    </>
  );
}
