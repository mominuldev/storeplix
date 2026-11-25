import { isApiError } from '@storeplix/api-client';
import type { Category } from '@storeplix/types';
import { Badge, Button, cn, Dialog, Drawer, Input, Label, Menu, Select, SortableTree, Tabs, Toggle, gripProps, validParentIds } from '@storeplix/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Copy, GripVertical, ImagePlus, MoreHorizontal, PenLine, Plus, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { PageHeader } from '../layout/PageHeader';
import { api } from '../lib/api';
import { toast } from '../online-store/components/Toast';
import { formatCount, plural } from '../catalog/format';
import { useCategories, useInvalidate, useProducts } from '../catalog/queries';
import { keys, useStoreScope } from '../catalog/scope';
import { ErrorBlock, errorMessage, LoadingRows, NoResults } from '../catalog/states';
import { iconButton, SearchBox, Thumb, useIsMobile } from '../catalog/ui';
import { useProductImageUpload } from '../catalog/useImageUpload';
import { storeDomain } from '../stores/useTenantStore';
import { CATEGORY_MAX_DEPTH, slugify, toReorderInput, toTree, treeToCategories, type CategoryNode } from './categoryTree';

// Figma Categories & collections 60:9778 (Main 60:9780), Category row 63:13890. Contract §4: Collections tab/card,
// "New collection", "Feature on homepage" and "sales · 30d" are hidden. Drag a row right onto another to nest
// (max 3 levels); the whole order is saved with PUT /categories/order.

type Editing = { mode: 'new' } | { mode: 'edit'; id: string } | null;

export function CategoriesPage() {
  const scope = useStoreScope();
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const invalidate = useInvalidate();
  const list = useCategories();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<Category | null>(null);
  const categories = useMemo(() => list.data ?? [], [list.data]);
  const tree = useMemo(() => toTree(categories), [categories]);

  const reorder = useMutation({
    mutationFn: (next: CategoryNode[]) => api.categories.reorder(scope.storeId!, toReorderInput(next)),
    onMutate: (next) => {
      const key = keys.categories(scope);
      const prev = queryClient.getQueryData(key);
      queryClient.setQueryData(key, (old: { data: Category[]; meta: unknown } | undefined) => (old ? { ...old, data: treeToCategories(next) } : old));
      return { prev };
    },
    onSuccess: () => toast('Menu order saved.'),
    onError: (e, _v, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(keys.categories(scope), ctx.prev);
      const detail = isApiError(e) ? Object.values(e.fieldErrors ?? {})[0]?.[0] : undefined;
      toast(detail ?? errorMessage(e, 'Couldn’t save the order. Try again.'), 'error');
    },
    onSettled: () => void invalidate.categories(),
  });

  const remove = useMutation({
    mutationFn: (c: Category) => api.categories.delete(scope.storeId!, c.id),
    onSuccess: async (_r, c) => {
      toast(`Deleted “${c.name}”.`);
      setDeleting(null);
      if (editing?.mode === 'edit' && editing.id === c.id) setEditing(null);
      await invalidate.categories();
    },
    onError: (e) => {
      setDeleting(null);
      toast(isApiError(e) && e.code === 'category_has_children' ? 'Move or delete its sub-categories first.' : errorMessage(e), 'error');
    },
  });

  const filtered = q.trim() ? categories.filter((c) => c.name.toLowerCase().includes(q.trim().toLowerCase())) : null;
  const totalProducts = categories.filter((c) => c.depth === 1).reduce((n, c) => n + c.product_count, 0);
  const editingCategory = editing?.mode === 'edit' ? (categories.find((c) => c.id === editing.id) ?? null) : null;

  const row = (c: Category, handle?: Parameters<typeof gripProps>[0], dragging = false) => (
    <div
      className={cn(
        'flex items-center gap-3 border-b border-border-default bg-surface-card px-4 py-3 sm:h-18',
        dragging && 'shadow-elevation-1',
        editingCategory?.id === c.id && 'bg-brand-50 shadow-[inset_0_0_0_1px_var(--color-brand-500)]',
      )}
    >
      {handle ? (
        <button type="button" aria-label={`Drag ${c.name}`} className="-m-1 cursor-grab rounded-sm p-1 text-text-muted touch-none" {...gripProps(handle)}>
          <GripVertical aria-hidden className="size-4" />
        </button>
      ) : (
        <span className="w-4" />
      )}
      <Thumb src={c.image?.url} size={48} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-body font-semibold text-text-primary">{c.name}</span>
        <span className="truncate text-caption text-text-muted">
          {c.url_path.replace(/^\/c/, '')}
          {c.children_count > 0 ? ` · ${plural(c.children_count, 'sub-category', 'sub-categories')}` : c.description ? ` · ${c.description}` : ''}
        </span>
      </span>
      <span className="hidden w-[100px] shrink-0 flex-col gap-0.5 sm:flex">
        <span className="text-body font-semibold text-text-primary">{formatCount(c.product_count)}</span>
        <span className="text-caption text-text-muted">products</span>
      </span>
      <span className="hidden w-[88px] shrink-0 sm:flex">
        <Badge tone={c.is_visible ? 'success' : 'neutral'} dot>
          {c.is_visible ? 'In menu' : 'Hidden'}
        </Badge>
      </span>
      <span className="flex shrink-0 justify-end gap-1 sm:w-[68px]">
        <button type="button" aria-label={`Edit ${c.name}`} className={iconButton} onClick={() => setEditing({ mode: 'edit', id: c.id })}>
          <PenLine aria-hidden className="text-text-secondary" />
        </button>
        {scope.canManageCatalog && (
          <Menu
            label={`More actions for ${c.name}`}
            triggerClassName={iconButton}
            trigger={<MoreHorizontal aria-hidden />}
            entries={[{ key: 'del', label: 'Delete', danger: true, onSelect: () => setDeleting(c) }]}
          />
        )}
      </span>
    </div>
  );

  const panel = editing && (
    <CategoryPanel
      key={editing.mode === 'edit' ? editing.id : 'new'}
      category={editingCategory}
      categories={categories}
      canDelete={scope.canManageCatalog}
      onClose={() => setEditing(null)}
      onDelete={(c) => setDeleting(c)}
      onSaved={(c) => setEditing({ mode: 'edit', id: c.id })}
    />
  );

  return (
    <>
      <PageHeader
        title="Categories"
        subtitle="Categories build your shop menu. Buyers see this order in your shop menu."
        actions={
          scope.canEditProducts && (
            <Button aria-label="New category" onClick={() => setEditing({ mode: 'new' })}>
              + New category
            </Button>
          )
        }
      />
      <Tabs aria-label="Catalog groups" value="categories" onChange={() => {}} items={[{ value: 'categories', label: 'Categories', count: categories.length }]} />
      <div className="grid gap-x-6 gap-y-5 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
        <section aria-label="Shop menu order" className="overflow-hidden rounded-card border border-border-default bg-surface-card shadow-elevation-1">
          <div className="flex flex-wrap items-center gap-3 border-b border-border-default px-5 py-4">
            <div className="flex min-w-0 flex-1 flex-col">
              <h2 className="text-body-lg font-medium text-text-primary">Shop menu order</h2>
              <p className="text-caption text-text-muted">Drag to reorder. Drag right onto a category to nest it (up to 3 levels).</p>
            </div>
            <SearchBox value={q} onChange={setQ} placeholder="Search categories" label="Search categories" className="h-10 w-full sm:w-[200px]" />
          </div>
          {list.isPending ? (
            <LoadingRows label="Loading categories" />
          ) : list.isError ? (
            <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
          ) : categories.length === 0 ? (
            <NoResults title="No categories yet" description="Categories group your products in the shop menu, e.g. Sarees › Silk." onClear={() => setEditing({ mode: 'new' })} clearLabel="Add a category" />
          ) : filtered ? (
            filtered.length ? (
              <ul aria-label="Categories">{filtered.map((c) => <li key={c.id}>{row(c)}</li>)}</ul>
            ) : (
              <NoResults title={`No categories match “${q.trim()}”`} onClear={() => setQ('')} />
            )
          ) : (
            <SortableTree
              label="Categories"
              items={tree}
              maxDepth={CATEGORY_MAX_DEPTH}
              indent={32}
              className="gap-0"
              disabled={reorder.isPending}
              onChange={(next) => reorder.mutate(next)}
              renderItem={(f, { handle, isDragging }) => row(f.node.category, handle, isDragging)}
            />
          )}
          <div className="flex flex-wrap items-center gap-4 px-5 py-3.5">
            <button type="button" onClick={() => setEditing({ mode: 'new' })} className="flex items-center gap-2 text-body font-semibold text-brand-600 hover:text-brand-700">
              <Plus aria-hidden className="size-5" /> Add category
            </button>
            <span className="text-caption text-text-muted">
              {plural(categories.length, 'category', 'categories')} · {plural(totalProducts, 'product')}
            </span>
          </div>
        </section>
        {!isMobile && panel}
      </div>
      {isMobile && (
        <Drawer open={!!editing} onClose={() => setEditing(null)} title={editing?.mode === 'new' ? 'New category' : 'Edit category'} side="bottom">
          {panel}
        </Drawer>
      )}
      <Dialog
        open={!!deleting}
        tone="danger"
        title={`Delete “${deleting?.name}”?`}
        description={deleting && deleting.children_count > 0 ? 'Move or delete its sub-categories first.' : 'Products stay in your catalog; they’re just removed from this category.'}
        confirmLabel="Delete"
        confirmDisabled={!!deleting && deleting.children_count > 0}
        loading={remove.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </>
  );
}

/** Side panel "Edit category" (60:9780 right column). */
function CategoryPanel({
  category,
  categories,
  canDelete,
  onClose,
  onDelete,
  onSaved,
}: {
  category: Category | null;
  categories: Category[];
  canDelete: boolean;
  onClose: () => void;
  onDelete: (c: Category) => void;
  onSaved: (c: Category) => void;
}) {
  const scope = useStoreScope();
  const invalidate = useInvalidate();
  const [name, setName] = useState(category?.name ?? '');
  const [slugInput, setSlug] = useState(category?.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(!!category);
  const slug = slugTouched ? slugInput : slugify(name);
  const [parentId, setParentId] = useState(category?.parent_id ?? '');
  const [description, setDescription] = useState(category?.description ?? '');
  const [visible, setVisible] = useState(category?.is_visible ?? true);
  const [image, setImage] = useState<{ id: string; url: string } | null>(category?.image ? { id: category.image.id, url: category.image.url } : null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const upload = useProductImageUpload((img) => setImage({ id: img.media_id, url: img.url }));
  const products = useProducts({ category_id: category?.id, per_page: 4 }, !!category);

  const allowedParents = useMemo(() => new Set(validParentIds(toTree(categories), category?.id ?? null, CATEGORY_MAX_DEPTH)), [categories, category]);
  const host = scope.store ? storeDomain(scope.store) : '';

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        ...(slug.trim() ? { slug: slug.trim() } : {}),
        parent_id: parentId || null,
        description: description.trim() || null,
        is_visible: visible,
        image_media_id: image?.id ?? null,
      };
      return category ? api.categories.update(scope.storeId!, category.id, body) : api.categories.create(scope.storeId!, body);
    },
    onSuccess: async (c) => {
      toast(category ? 'Category saved.' : `Added “${c.name}”.`);
      await invalidate.categories();
      onSaved(c);
    },
    onError: (e) => {
      if (isApiError(e) && e.isValidation && e.fieldErrors) {
        const next: Record<string, string> = {};
        for (const [k, v] of Object.entries(e.fieldErrors)) next[k] = v[0]!;
        setErrors(next);
        setFormError(null);
      } else setFormError(isApiError(e) && e.code === 'category_limit_reached' ? 'You’ve reached 500 categories.' : errorMessage(e));
    },
  });

  const submit = () => {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = 'Give the category a name.';
    if (slug.trim() && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug.trim())) next.slug = 'Use lowercase letters, numbers and dashes.';
    setErrors(next);
    if (!Object.keys(next).length) save.mutate();
  };

  return (
    <section aria-label={category ? 'Edit category' : 'New category'} className="flex flex-col rounded-card border border-border-default bg-surface-card shadow-elevation-1">
      <div className="flex items-start gap-3 border-b border-border-default px-5 py-4">
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="text-body-lg font-medium text-text-primary">{category ? 'Edit category' : 'New category'}</h2>
          {category && <p className="truncate text-caption text-text-muted">{category.name}</p>}
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className={iconButton}>
          <X aria-hidden />
        </button>
      </div>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex flex-col gap-4 px-5 py-4"
      >
        <div className="flex flex-col gap-2">
          <Label>Cover image</Label>
          <div className="flex aspect-[2.25] items-center justify-center overflow-hidden rounded-lg bg-surface-subtle">
            {image ? <img src={image.url} alt="" className="size-full object-cover" /> : <ImagePlus aria-hidden className="size-6 text-text-muted" />}
          </div>
          <div className="flex items-center gap-2">
            <label className="cursor-pointer rounded-md border border-border-default px-3 py-1.5 text-caption font-medium text-text-primary hover:bg-surface-subtle">
              {upload.progress !== null ? `Uploading ${Math.round(upload.progress * 100)}%` : image ? 'Replace' : 'Upload'}
              <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" aria-label="Upload cover image" onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void upload.upload([f], 1);
              }} />
            </label>
            {image && (
              <Button size="sm" variant="ghost" onClick={() => setImage(null)}>
                Remove
              </Button>
            )}
          </div>
          {upload.error && <p className="text-caption text-danger">{upload.error}</p>}
        </div>
        <Input label="Category name" value={name} maxLength={120} error={errors.name} onChange={(e) => setName(e.target.value)} />
        <Input
          label="Link"
          value={slug}
          maxLength={140}
          error={errors.slug}
          leading={<span className="text-caption text-text-muted">/c/</span>}
          hint={host ? `${host}/c/${slug || '…'}` : undefined}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value);
          }}
          trailing={
            host && slug ? (
              <button type="button" aria-label="Copy link" onClick={() => void navigator.clipboard?.writeText(`https://${host}/c/${slug}`).then(() => toast('Link copied.'))}>
                <Copy aria-hidden />
              </button>
            ) : undefined
          }
        />
        <Select label="Parent category" value={parentId} error={errors.parent_id} onChange={(e) => setParentId(e.target.value)}>
          <option value="">None — top level</option>
          {categories
            .filter((c) => allowedParents.has(c.id) || c.id === parentId)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {'— '.repeat(c.depth - 1)}
                {c.name}
              </option>
            ))}
        </Select>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="cat-desc">Short description</Label>
          <textarea id="cat-desc" rows={3} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} className="rounded-md border border-border-default px-3 py-2 text-body outline-none focus:border-brand-600" />
          {errors.description && <p className="text-caption text-danger">{errors.description}</p>}
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="flex flex-col">
            <span className="text-body font-medium text-text-primary">Show in shop menu</span>
            <span className="text-caption text-text-muted">Appears in the top menu and on mobile</span>
          </span>
          <Toggle label="Show in shop menu" checked={visible} onChange={setVisible} />
        </div>
        {category && (
          <div className="flex flex-col gap-2 rounded-lg bg-surface-subtle p-3">
            <span className="text-body font-medium text-text-primary">
              {plural(category.product_count, 'product')} in {category.name}
            </span>
            <div className="flex items-center gap-2">
              {(products.data?.data ?? []).map((p) => (
                <Thumb key={p.id} src={p.image?.url} size={44} alt={p.name} />
              ))}
              {category.product_count > 4 && <span className="text-caption font-medium text-brand-600">+{category.product_count - 4}</span>}
            </div>
          </div>
        )}
        {formError && (
          <p role="alert" className="text-caption text-danger">
            {formError}
          </p>
        )}
        <div className="flex items-center gap-2 border-t border-border-default pt-4">
          {category && canDelete && (
            <Button variant="ghost" size="sm" className="text-danger hover:bg-danger-bg" onClick={() => onDelete(category)}>
              Delete
            </Button>
          )}
          <span className="flex-1" />
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" type="submit" loading={save.isPending}>
            Save
          </Button>
        </div>
      </form>
    </section>
  );
}

export default CategoriesPage;
