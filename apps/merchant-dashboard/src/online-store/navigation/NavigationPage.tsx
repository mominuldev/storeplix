import { isApiError } from '@storeplix/api-client';
import type { NavigationHandle, NavigationMenu, NavItem, NavLink, NavLinkStatus, StorePageSummary } from '@storeplix/types';
import { Badge, Button, cn, DraftBar, DraftBarGhostButton, gripProps, Input, Modal, Select, SortableTree } from '@storeplix/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CornerDownRight, CornerLeftUp, GripVertical, Link2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../lib/api';
import { useTenantStore } from '../../stores/useTenantStore';
import { ConflictDialog, ErrorState, LoadingState, OnlineStoreHeader, Panel, ReadOnlyBanner } from '../components/Shell';
import { toast } from '../components/Toast';
import { osKeys, useCanEditStore, useNavigationMenus, useStorePages } from '../hooks';
import { countItems, describeLink, labelError, linkError, menuError, NAV_LIMITS, nestUnderPrevious, newNavItem, removeItem, toNavItems, unnest, updateItem } from './navState';

// Figma V3 Navigation 2037:46510 (Main 2037:46512): menus list (Main, Footer, Help), tree editor (drag to
// reorder, drag right / "nest" to put a link under the one above, max two levels), add/edit/delete, suggested
// chips from published pages, broken-link warnings, live preview card, bottom "N unsaved changes" bar.
// Out of scope: "Mobile bar" menu, "+ New menu", Landing page link type.

const menuMeta: Record<NavigationHandle, string> = { main: 'Header', footer: 'Footer, column 1', help: 'Footer, column 2' };

function statusFor(link: NavLink, pages: StorePageSummary[], fallback?: NavLinkStatus): NavLinkStatus {
  if (link.type !== 'page') return 'ok';
  const page = pages.find((p) => p.id === link.page_id);
  if (!page) return pages.length ? 'page_missing' : (fallback ?? 'ok');
  return page.status === 'published' ? 'ok' : 'page_unpublished';
}

export function NavigationPage() {
  const menus = useNavigationMenus();
  const pages = useStorePages();
  if (menus.isPending) return <LoadingState label="Loading menus" />;
  if (menus.isError) return <ErrorState onRetry={() => void menus.refetch()} />;
  return <NavigationEditor menus={menus.data} pages={pages.data?.data ?? []} />;
}

function NavigationEditor({ menus, pages }: { menus: NavigationMenu[]; pages: StorePageSummary[] }) {
  const canEdit = useCanEditStore();
  const store = useTenantStore().data!;
  const queryClient = useQueryClient();
  const [handle, setHandle] = useState<NavigationHandle>('main');
  const [drafts, setDrafts] = useState<Partial<Record<NavigationHandle, NavItem[]>>>({});
  const [editing, setEditing] = useState<NavItem | 'new' | null>(null);
  const [conflict, setConflict] = useState(false);
  const menu = menus.find((m) => m.handle === handle) ?? menus[0]!;
  const serverItems = toNavItems(menu.items);
  const items = drafts[handle] ?? serverItems;
  const dirty = JSON.stringify(items) !== JSON.stringify(serverItems);
  const problem = menuError(items);
  const resolved = new Map<string, NavLinkStatus>();
  const walk = (list: typeof menu.items) => list.forEach((i) => (resolved.set(i.id, i.link_status), walk(i.children ?? [])));
  walk(menu.items);
  const pageTitle = (id: string) => pages.find((p) => p.id === id)?.title ?? menu.items.flatMap((i) => [i, ...(i.children ?? [])]).find((i) => i.link.type === 'page' && i.link.page_id === id)?.page_title ?? null;

  const setItems = (next: NavItem[]) => canEdit && setDrafts((d) => ({ ...d, [handle]: next }));

  const save = useMutation({
    mutationFn: () => api.navigation.save(store.id, handle, { items, revision: menu.revision }),
    onSuccess: (saved) => {
      queryClient.setQueryData<NavigationMenu[]>(osKeys.navigation(store.id), (old) => old?.map((m) => (m.handle === saved.handle ? saved : m)));
      setDrafts((d) => ({ ...d, [handle]: undefined }));
      void queryClient.invalidateQueries({ queryKey: osKeys.pages(store.id) });
      toast(`${saved.title} saved. Your shop updates in a few seconds.`);
    },
    onError: (e) => {
      if (isApiError(e) && e.status === 409) setConflict(true);
      else toast(isApiError(e) ? (Object.values(e.details ?? {})[0]?.[0] ?? e.message) : 'Couldn’t save the menu. Try again.', 'error');
    },
  });

  const suggestions = pages.filter((p) => p.status === 'published' && !items.some((i) => (i.link.type === 'page' && i.link.page_id === p.id) || i.children?.some((c) => c.link.type === 'page' && c.link.page_id === p.id))).slice(0, 4);
  const total = countItems(items);
  const changeCount = dirty ? Math.max(1, Math.abs(total - countItems(serverItems)) || 1) : 0;

  return (
    <div className="flex flex-col gap-6 lg:gap-8">
      <OnlineStoreHeader title="Navigation" description="The menus in your header and footer. Changes show in the preview as you type." />
      {!canEdit && <ReadOnlyBanner />}

      <div className="grid gap-6 lg:grid-cols-[232px_minmax(0,1fr)_minmax(0,360px)]">
        <nav aria-label="Menus" className="flex flex-col gap-2.5">
          <span className="text-[11px] leading-4 font-semibold tracking-[0.66px] text-text-muted uppercase">Menus</span>
          {menus.map((m) => {
            const active = m.handle === handle;
            const count = countItems(drafts[m.handle] ?? toNavItems(m.items));
            return (
              <button
                key={m.handle}
                type="button"
                aria-current={active ? 'true' : undefined}
                onClick={() => setHandle(m.handle)}
                className={cn(
                  'flex flex-col rounded-lg border bg-surface-card px-4 py-3 text-left outline-none focus-visible:shadow-focus',
                  active ? 'border-brand-600 shadow-[0_0_0_0.5px_var(--color-brand-600)]' : 'border-border-default hover:border-border-strong',
                )}
              >
                <span className="text-body font-semibold text-text-primary">
                  {m.title}
                  {drafts[m.handle] && <span className="ml-1.5 inline-block size-1.5 rounded-full bg-accent-500 align-middle" aria-label="unsaved" />}
                </span>
                <span className="text-caption text-text-muted">
                  {count} link{count === 1 ? '' : 's'} · {menuMeta[m.handle]}
                </span>
              </button>
            );
          })}
        </nav>

        <Panel title={menu.title} description={`${menuMeta[handle]} on every page · drag to reorder, drag right onto a link to nest`}>
          {items.length === 0 && <p className="text-body text-text-secondary">This menu is empty. Add your first link below.</p>}
          <SortableTree<NavItem>
            label={`${menu.title} links`}
            items={items}
            maxDepth={NAV_LIMITS.maxDepth - 1}
            disabled={!canEdit}
            onChange={setItems}
            renderItem={(flat, { handle: h }) => {
              const item = flat.node;
              const status = statusFor(item.link, pages, resolved.get(item.id));
              const index = items.findIndex((i) => i.id === item.id);
              return (
                <div className={cn('flex items-center gap-2 rounded-lg bg-surface-subtle py-2.5 pr-2 pl-2', status !== 'ok' && 'shadow-[inset_0_0_0_1px_var(--color-warning)]')}>
                  {canEdit && (
                    <button type="button" aria-label={`Reorder ${item.label}`} {...gripProps(h)} className="flex size-6 cursor-grab touch-none items-center justify-center text-text-muted">
                      <GripVertical aria-hidden className="size-4" />
                    </button>
                  )}
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-body-lg text-text-primary">{item.label}</span>
                    <span className="flex items-center gap-1 truncate text-caption text-text-muted">
                      <Link2 aria-hidden className="size-3 shrink-0" />
                      {describeLink(item.link, item.link.type === 'page' ? pageTitle(item.link.page_id) : null)}
                    </span>
                    {item.link.type === 'collection' && <span className="text-[11px] text-text-muted">Collections arrive with products</span>}
                  </div>
                  {status !== 'ok' && (
                    <Badge tone="warning" title="Hidden from buyers until fixed">
                      <AlertTriangle aria-hidden className="size-3" /> {status === 'page_missing' ? 'Page deleted' : 'Page not published'}
                    </Badge>
                  )}
                  {canEdit && (
                    <div className="flex shrink-0 gap-1">
                      {flat.depth === 1 ? (
                        <IconBtn label={`Move ${item.label} out`} onClick={() => setItems(unnest(items, item.id))}>
                          <CornerLeftUp />
                        </IconBtn>
                      ) : (
                        index > 0 &&
                        !item.children?.length && (
                          <IconBtn label={`Nest ${item.label} under the link above`} onClick={() => setItems(nestUnderPrevious(items, item.id))}>
                            <CornerDownRight />
                          </IconBtn>
                        )
                      )}
                      <IconBtn label={`Edit ${item.label}`} onClick={() => setEditing(item)}>
                        <Pencil />
                      </IconBtn>
                      <IconBtn label={`Delete ${item.label}`} danger onClick={() => setItems(removeItem(items, item.id))}>
                        <Trash2 />
                      </IconBtn>
                    </div>
                  )}
                </div>
              );
            }}
          />
          {canEdit && (
            <div className="flex flex-col gap-3 rounded-lg border border-dashed border-border-strong p-4">
              <button
                type="button"
                disabled={items.length >= NAV_LIMITS.top || total >= NAV_LIMITS.total}
                onClick={() => setEditing('new')}
                className="flex items-center gap-2 self-start text-body-lg font-medium text-brand-600 disabled:opacity-50"
              >
                <Plus aria-hidden className="size-4" /> Add a link
              </button>
              {suggestions.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 text-caption text-text-muted">
                  Suggested:
                  {suggestions.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setItems([...items, newNavItem(items, p.title.slice(0, 40), { type: 'page', page_id: p.id })])}
                      className="rounded-full border border-border-default bg-surface-card px-2.5 py-1 text-caption text-text-primary hover:border-brand-500"
                    >
                      + {p.title}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </Panel>

        <aside aria-label="Live preview" className="flex flex-col gap-3">
          <h2 className="text-body-lg font-semibold text-text-primary">Live preview</h2>
          <MenuPreview handle={handle} items={items} storeName={store.name} />
          <Panel title="Keep it to 5–7 links" description="On phones, more than 7 links pushes Track order out of sight — the link buyers use most after ordering." />
        </aside>
      </div>

      {canEdit && dirty && (
        <DraftBar
          title={`${changeCount} unsaved change${changeCount === 1 ? '' : 's'}`}
          description={problem ?? `${menu.title} · not live yet`}
          actions={
            <>
              <DraftBarGhostButton onClick={() => setDrafts((d) => ({ ...d, [handle]: undefined }))}>Discard</DraftBarGhostButton>
              <Button loading={save.isPending} disabled={!!problem} onClick={() => save.mutate()}>
                Save menu
              </Button>
            </>
          }
        />
      )}

      {editing && (
        <LinkDialog
          item={editing === 'new' ? null : editing}
          pages={pages}
          onClose={() => setEditing(null)}
          onSave={(label, link) => {
            if (editing === 'new') setItems([...items, newNavItem(items, label, link)]);
            else setItems(updateItem(items, editing.id, { label, link }));
            setEditing(null);
          }}
        />
      )}
      <ConflictDialog
        open={conflict}
        onReload={async () => {
          setConflict(false);
          setDrafts((d) => ({ ...d, [handle]: undefined }));
          await queryClient.invalidateQueries({ queryKey: osKeys.navigation(store.id) });
        }}
      />
    </div>
  );
}

function IconBtn({ label, onClick, children, danger }: { label: string; onClick: () => void; children: React.ReactNode; danger?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn('flex size-7 items-center justify-center rounded-md bg-surface-card shadow-elevation-1 outline-none focus-visible:shadow-focus [&_svg]:size-3.5', danger ? 'text-danger' : 'text-text-secondary')}
    >
      {children}
    </button>
  );
}

type LinkType = NavLink['type'];

/** "+ Add a link" / edit: label + link-type picker (Home, Page, Collection, Built-in, Web address). */
function LinkDialog({ item, pages, onClose, onSave }: { item: NavItem | null; pages: StorePageSummary[]; onClose: () => void; onSave: (label: string, link: NavLink) => void }) {
  const initial = item?.link ?? { type: 'page' as const, page_id: pages[0]?.id ?? '' };
  const [label, setLabel] = useState(item?.label ?? '');
  const [type, setType] = useState<LinkType>(initial.type);
  const [pageId, setPageId] = useState(initial.type === 'page' ? initial.page_id : (pages[0]?.id ?? ''));
  const [url, setUrl] = useState(initial.type === 'url' ? initial.url : 'https://');
  const [collection, setCollection] = useState(initial.type === 'collection' ? initial.handle : '');
  const [target, setTarget] = useState<'track_order' | 'cart' | 'search'>(initial.type === 'builtin' ? initial.target : 'track_order');
  const [touched, setTouched] = useState(false);

  const link: NavLink =
    type === 'home'
      ? { type }
      : type === 'page'
        ? { type, page_id: pageId }
        : type === 'url'
          ? { type, url: url.trim() }
          : type === 'collection'
            ? { type, handle: collection.trim() }
            : { type, target };
  const lErr = labelError(label);
  const kErr = linkError(link);
  const defaultLabel = type === 'home' ? 'Home' : type === 'page' ? (pages.find((p) => p.id === pageId)?.title ?? '') : type === 'builtin' ? { track_order: 'Track order', cart: 'Cart', search: 'Search' }[target] : '';

  return (
    <Modal
      open
      onClose={onClose}
      title={item ? 'Edit link' : 'Add a link'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              setTouched(true);
              const finalLabel = (label.trim() || defaultLabel).slice(0, 40);
              if (!labelError(finalLabel) && !kErr) onSave(finalLabel, link);
            }}
          >
            {item ? 'Save link' : 'Add link'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Select label="Links to" value={type} onChange={(e) => setType(e.target.value as LinkType)}>
          <option value="home">Home page</option>
          <option value="page">A page</option>
          <option value="collection">A collection</option>
          <option value="builtin">A shop page (Track order, Cart, Search)</option>
          <option value="url">A web address</option>
        </Select>
        {type === 'page' &&
          (pages.length ? (
            <Select label="Page" value={pageId} onChange={(e) => setPageId(e.target.value)}>
              {pages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                  {p.status !== 'published' ? ` (${p.status})` : ''}
                </option>
              ))}
            </Select>
          ) : (
            <p className="text-body text-text-secondary">You don’t have any pages yet.</p>
          ))}
        {type === 'collection' && <Input label="Collection link name" placeholder="winter-sale" value={collection} onChange={(e) => setCollection(e.target.value.toLowerCase())} hint="Collections arrive with products" error={touched && kErr ? kErr : undefined} />}
        {type === 'builtin' && (
          <Select label="Shop page" value={target} onChange={(e) => setTarget(e.target.value as typeof target)}>
            <option value="track_order">Track order</option>
            <option value="cart">Cart</option>
            <option value="search">Search</option>
          </Select>
        )}
        {type === 'url' && <Input label="Web address" type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} error={touched && kErr ? kErr : undefined} />}
        <Input label="Label" placeholder={defaultLabel || 'Shop'} maxLength={40} value={label} onChange={(e) => setLabel(e.target.value)} error={touched && lErr && !defaultLabel ? lErr : undefined} />
      </div>
    </Modal>
  );
}

function MenuPreview({ handle, items, storeName }: { handle: NavigationHandle; items: NavItem[]; storeName: string }) {
  const withChildren = items.find((i) => i.children?.length);
  return (
    <div className="rounded-card bg-brand-100 p-4">
      <div className="overflow-hidden rounded-lg border border-border-default bg-surface-card shadow-elevation-1">
        {handle === 'main' ? (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-default px-3 py-2.5 text-[11px] text-text-secondary">
              <span className="flex items-center gap-1.5 text-caption font-semibold text-text-primary">
                <span className="size-3 rounded-sm bg-brand-600" />
                {storeName}
              </span>
              {items.map((i) => (
                <span key={i.id} className={cn(i.id === withChildren?.id && 'rounded-full bg-brand-50 px-1.5 text-brand-700')}>
                  {i.label}
                  {i.children?.length ? ' ▾' : ''}
                </span>
              ))}
            </div>
            <div className="relative h-36 bg-surface-subtle">
              {withChildren && (
                <ul className="absolute top-2 left-1/3 flex w-32 flex-col gap-1 rounded-md bg-surface-card p-2 text-[11px] text-text-secondary shadow-elevation-1">
                  {withChildren.children!.map((c) => (
                    <li key={c.id}>{c.label}</li>
                  ))}
                </ul>
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-1.5 bg-text-primary px-4 py-4 text-caption text-text-inverse">
            <span className="font-semibold">{handle === 'footer' ? 'Shop' : 'Help'}</span>
            {items.map((i) => (
              <span key={i.id} className="opacity-80">
                {i.label}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
