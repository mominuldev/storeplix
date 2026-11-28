import type {
  AssignInboxConversationInput,
  Conditional,
  InboxConversation,
  InboxConversationSummary,
  InboxListFilters,
  InboxListMeta,
  InboxMessage,
  InboxSavedReply,
  InboxSavedReplyFilters,
  InboxSavedReplyInput,
  InboxStatus,
  InboxSummary,
  SendInboxMessageInput,
  UpdateInboxSavedReplyInput,
  UpdateInboxSettingsInput,
} from '@storeplix/types';
import { INBOX_LIMITS, INBOX_POLL_MS } from '@storeplix/types';
import type { UploadOptions } from '@storeplix/api-client';
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthProvider';
import { useStoreScope } from '../catalog/scope';
import { api } from '../lib/api';
import { canUseInbox, mergeMessages } from './inbox';

// PHASE-8-8E §5–§8, §12 server state. Keys: [tenantId, storeId, 'inbox', …]. Summary, list and thread poll with
// TanStack Query `refetchInterval` (paused while the tab is hidden, refetched on focus) and send the cached ETag as
// `If-None-Match`; a 304 keeps the cached value (same reference, nothing re-renders). The thread polls with `after`.

type Scope = { tenantId: string | null; storeId: string | null };

export const inboxKeys = {
  all: (s: Scope) => [s.tenantId, s.storeId, 'inbox'] as const,
  summary: (s: Scope) => [s.tenantId, s.storeId, 'inbox', 'summary'] as const,
  lists: (s: Scope) => [s.tenantId, s.storeId, 'inbox', 'list'] as const,
  list: (s: Scope, f: InboxListFilters) => [s.tenantId, s.storeId, 'inbox', 'list', f] as const,
  conversation: (s: Scope, id: string | null) => [s.tenantId, s.storeId, 'inbox', 'conversation', id] as const,
  messages: (s: Scope, id: string | null) => [s.tenantId, s.storeId, 'inbox', 'messages', id] as const,
  assignees: (s: Scope) => [s.tenantId, s.storeId, 'inbox', 'assignees'] as const,
  savedReplies: (s: Scope, f?: InboxSavedReplyFilters) =>
    f === undefined ? ([s.tenantId, s.storeId, 'inbox', 'saved-replies'] as const) : ([s.tenantId, s.storeId, 'inbox', 'saved-replies', f] as const),
  settings: (s: Scope) => [s.tenantId, s.storeId, 'inbox', 'settings'] as const,
  link: (s: Scope, attachmentId: string) => [s.tenantId, s.storeId, 'inbox', 'link', attachmentId] as const,
};

/** Cached value of a conditional GET. */
export interface Etagged<T> {
  data: T;
  etag: string | null;
}

/** Resolve a conditional GET against the cached value (304 → the cached object itself). */
export function resolveConditional<T>(prev: Etagged<T> | undefined, r: Conditional<T>): Etagged<T> {
  if (r.status === 'not_modified') {
    if (!prev) throw new Error('304 without a cached value');
    return prev.etag === r.etag || !r.etag ? prev : { ...prev, etag: r.etag };
  }
  return { data: r.data, etag: r.etag };
}

async function conditionalFetch<T>(qc: QueryClient, key: QueryKey, run: (etag: string | null) => Promise<Conditional<T>>): Promise<Etagged<T>> {
  const prev = qc.getQueryData<Etagged<T>>(key);
  return resolveConditional(prev, await run(prev?.etag ?? null));
}

/** §12 sidebar badge + chip counts: every page, only with `inbox.manage`, every 30 s. */
export function useInboxSummary() {
  const s = useStoreScope();
  const { activeTenant } = useAuth();
  const qc = useQueryClient();
  const key = inboxKeys.summary(s);
  return useQuery({
    queryKey: key,
    queryFn: ({ signal }) => conditionalFetch<InboxSummary>(qc, key, (etag) => api.inbox.summary(s.storeId!, { etag, signal })),
    enabled: !!s.storeId && canUseInbox(activeTenant),
    refetchInterval: INBOX_POLL_MS.summary,
    retry: false,
    select: (r) => r.data,
  });
}

export type ListPage = { data: InboxConversationSummary[]; meta: InboxListMeta };

/** §5 first page of the list, polled every 15 s while `/inbox` is open. */
export function useConversationList(filters: InboxListFilters) {
  const s = useStoreScope();
  const qc = useQueryClient();
  const key = inboxKeys.list(s, filters);
  return useQuery({
    queryKey: key,
    queryFn: ({ signal }) => conditionalFetch<ListPage>(qc, key, (etag) => api.inbox.conversations(s.storeId!, filters, { etag, signal })),
    enabled: !!s.storeId,
    refetchInterval: INBOX_POLL_MS.list,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** Further list pages ("Load more"), not polled. */
export function fetchListPage(storeId: string, filters: InboxListFilters, cursor: string) {
  return api.inbox.conversations(storeId, { ...filters, cursor }).then((r) => (r.status === 'ok' ? r.data : null));
}

export function useConversation(id: string | null) {
  const s = useStoreScope();
  return useQuery({
    queryKey: inboxKeys.conversation(s, id),
    queryFn: () => api.inbox.conversation(s.storeId!, id!),
    enabled: !!s.storeId && !!id,
    retry: false,
  });
}

export interface Thread {
  messages: InboxMessage[];
  /** an initial/history page came back full: older messages may exist */
  hasMore: boolean;
}

/**
 * §6.2 thread: the first fetch loads the latest 50; every 5 s poll asks only for rows `after` the newest cached id
 * (with the ETag). New rows refresh the conversation header (status/assignee may have changed).
 */
export function useThread(id: string | null) {
  const s = useStoreScope();
  const qc = useQueryClient();
  const key = inboxKeys.messages(s, id);
  return useQuery({
    queryKey: key,
    queryFn: async ({ signal }): Promise<Etagged<Thread>> => {
      const prev = qc.getQueryData<Etagged<Thread>>(key);
      const last = prev?.data.messages.at(-1)?.id;
      if (!prev || !last) {
        const r = await api.inbox.messages(s.storeId!, id!, {}, { etag: prev?.etag ?? null, signal });
        if (r.status === 'not_modified' && prev) return prev;
        const rows = r.status === 'ok' ? (r.data ?? []) : [];
        return { data: { messages: mergeMessages([], rows), hasMore: rows.length >= INBOX_LIMITS.messages_per_page }, etag: r.etag };
      }
      const r = await api.inbox.messages(s.storeId!, id!, { after: last }, { etag: prev.etag, signal });
      if (r.status === 'not_modified') return prev;
      const rows = r.data ?? [];
      if (rows.length === 0) {
        // A new ETag with no new rows means something else changed, e.g. the shopper saw a reply (customer_seen_at):
        // refresh the header so "Seen" updates live (QA 8.8e WEB-3).
        if (r.etag !== prev.etag) void qc.invalidateQueries({ queryKey: inboxKeys.conversation(s, id) });
        return { ...prev, etag: r.etag };
      }
      // read the cache again: a send may have merged rows while this poll was in flight
      const latest = qc.getQueryData<Etagged<Thread>>(key) ?? prev;
      void qc.invalidateQueries({ queryKey: inboxKeys.conversation(s, id) });
      return { data: { ...latest.data, messages: mergeMessages(latest.data.messages, rows) }, etag: r.etag };
    },
    enabled: !!s.storeId && !!id,
    refetchInterval: INBOX_POLL_MS.thread,
    retry: false,
  });
}

/** History: the 50 before the oldest cached row, merged into the cache. */
export function useLoadEarlier(id: string | null) {
  const s = useStoreScope();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const key = inboxKeys.messages(s, id);
      const first = qc.getQueryData<Etagged<Thread>>(key)?.data.messages[0]?.id;
      const r = await api.inbox.messages(s.storeId!, id!, { before: first });
      return r.status === 'ok' ? (r.data ?? []) : [];
    },
    onSuccess: (rows) => {
      qc.setQueryData<Etagged<Thread>>(inboxKeys.messages(s, id), (prev) =>
        prev ? { ...prev, data: { messages: mergeMessages(prev.data.messages, rows), hasMore: rows.length >= INBOX_LIMITS.messages_per_page } } : prev,
      );
    },
  });
}

/** Refresh list + badge after a write. */
export function useInboxRefresh() {
  const s = useStoreScope();
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: inboxKeys.lists(s) }), qc.invalidateQueries({ queryKey: inboxKeys.summary(s) })]);
}

/** §6.2 send a reply / note; the stored row is merged into the thread (idempotent on `client_id`). */
export function useSendMessage(id: string | null) {
  const s = useStoreScope();
  const qc = useQueryClient();
  const refresh = useInboxRefresh();
  return useMutation({
    mutationFn: (input: SendInboxMessageInput) => api.inbox.send(s.storeId!, id!, input),
    onSuccess: (message) => {
      qc.setQueryData<Etagged<Thread>>(inboxKeys.messages(s, id), (prev) =>
        prev ? { ...prev, data: { ...prev.data, messages: mergeMessages(prev.data.messages, [message]) } } : { data: { messages: [message], hasMore: false }, etag: null },
      );
      void qc.invalidateQueries({ queryKey: inboxKeys.conversation(s, id) });
      void refresh();
    },
  });
}

/** Conversation actions answering `InboxConversation` (assign, status, order, block). */
function useConversationAction<V>(id: string | null, run: (storeId: string, id: string, v: V) => Promise<InboxConversation>) {
  const s = useStoreScope();
  const qc = useQueryClient();
  const refresh = useInboxRefresh();
  return useMutation({
    mutationFn: (v: V) => run(s.storeId!, id!, v),
    onSuccess: (conversation) => {
      qc.setQueryData(inboxKeys.conversation(s, id), conversation);
      void qc.invalidateQueries({ queryKey: inboxKeys.messages(s, id) });
      void qc.invalidateQueries({ queryKey: inboxKeys.assignees(s) });
      void refresh();
    },
    onError: () => void qc.invalidateQueries({ queryKey: inboxKeys.conversation(s, id) }),
  });
}

export const useAssign = (id: string | null) => useConversationAction(id, (st, c, v: AssignInboxConversationInput) => api.inbox.assign(st, c, v));
export const useSetStatus = (id: string | null) =>
  useConversationAction(id, (st, c, v: { status: InboxStatus; revision?: number }) => api.inbox.setStatus(st, c, v));
export const useLinkOrder = (id: string | null) => useConversationAction(id, (st, c, v: { order_id: string | null }) => api.inbox.linkOrder(st, c, v));
export const useBlock = (id: string | null) =>
  useConversationAction(id, (st, c, blocked: boolean) => (blocked ? api.inbox.block(st, c) : api.inbox.unblock(st, c)));

/** Undo a close (2121:51977): the conversation id travels with the variables (the toast outlives the selection). */
export function useRestoreStatus() {
  const s = useStoreScope();
  const qc = useQueryClient();
  const refresh = useInboxRefresh();
  return useMutation({
    mutationFn: (v: { id: string; status: InboxStatus }) => api.inbox.setStatus(s.storeId!, v.id, { status: v.status }),
    onSuccess: (conversation) => {
      qc.setQueryData(inboxKeys.conversation(s, conversation.id), conversation);
      void qc.invalidateQueries({ queryKey: inboxKeys.messages(s, conversation.id) });
      void refresh();
    },
  });
}

export function useDeleteConversation() {
  const s = useStoreScope();
  const qc = useQueryClient();
  const refresh = useInboxRefresh();
  return useMutation({
    mutationFn: (id: string) => api.inbox.remove(s.storeId!, id),
    onSuccess: (_, id) => {
      qc.removeQueries({ queryKey: inboxKeys.conversation(s, id) });
      qc.removeQueries({ queryKey: inboxKeys.messages(s, id) });
      void refresh();
    },
  });
}

/** §6.4 read marking; the row's unread badge is cleared at once, the badge refetches. */
export function useMarkRead(id: string | null) {
  const s = useStoreScope();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (lastReadId: string) => api.inbox.markRead(s.storeId!, id!, { last_read_message_id: lastReadId }),
    onSuccess: () => {
      qc.setQueriesData<Etagged<ListPage>>({ queryKey: inboxKeys.lists(s) }, (prev) =>
        prev ? { ...prev, data: { ...prev.data, data: prev.data.data.map((c) => (c.id === id ? { ...c, unread_count: 0 } : c)) } } : prev,
      );
      void qc.invalidateQueries({ queryKey: inboxKeys.summary(s) });
    },
  });
}

export function useAssignees(enabled = true) {
  const s = useStoreScope();
  return useQuery({ queryKey: inboxKeys.assignees(s), queryFn: () => api.inbox.assignees(s.storeId!), enabled: enabled && !!s.storeId, retry: false, staleTime: 30_000 });
}

export function useUploadAttachment() {
  const s = useStoreScope();
  return useMutation({ mutationFn: (v: { file: File; opts?: UploadOptions }) => api.inbox.uploadAttachment(s.storeId!, { file: v.file }, v.opts) });
}

/** Signed 5-minute link (§7); cached 4 minutes, never in a support session. */
export function useAttachmentLink(attachmentId: string, enabled: boolean) {
  const s = useStoreScope();
  return useQuery({
    queryKey: inboxKeys.link(s, attachmentId),
    queryFn: () => api.inbox.attachmentLink(s.storeId!, attachmentId),
    enabled: enabled && !!s.storeId,
    staleTime: 4 * 60_000,
    gcTime: 4 * 60_000,
    retry: false,
  });
}

export function fetchAttachmentLink(qc: QueryClient, s: Scope, attachmentId: string) {
  return qc.fetchQuery({ queryKey: inboxKeys.link(s, attachmentId), queryFn: () => api.inbox.attachmentLink(s.storeId!, attachmentId), staleTime: 4 * 60_000 });
}

// ----- Saved replies (§8) -----
export function useSavedReplies(filters: InboxSavedReplyFilters = {}, enabled = true) {
  const s = useStoreScope();
  return useQuery({
    queryKey: inboxKeys.savedReplies(s, filters),
    queryFn: () => api.inbox.savedReplies.list(s.storeId!, filters),
    enabled: enabled && !!s.storeId,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

function useSavedRepliesInvalidate() {
  const s = useStoreScope();
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: inboxKeys.savedReplies(s) });
}

export function useCreateSavedReply() {
  const s = useStoreScope();
  const invalidate = useSavedRepliesInvalidate();
  return useMutation({ mutationFn: (input: InboxSavedReplyInput) => api.inbox.savedReplies.create(s.storeId!, input), onSuccess: () => void invalidate() });
}

export function useUpdateSavedReply() {
  const s = useStoreScope();
  const invalidate = useSavedRepliesInvalidate();
  return useMutation({
    mutationFn: (v: { id: string; input: UpdateInboxSavedReplyInput }) => api.inbox.savedReplies.update(s.storeId!, v.id, v.input),
    onSuccess: () => void invalidate(),
  });
}

export function useDeleteSavedReply() {
  const s = useStoreScope();
  const invalidate = useSavedRepliesInvalidate();
  return useMutation({ mutationFn: (id: string) => api.inbox.savedReplies.remove(s.storeId!, id), onSuccess: () => void invalidate() });
}

export function useReorderSavedReplies() {
  const s = useStoreScope();
  const qc = useQueryClient();
  const invalidate = useSavedRepliesInvalidate();
  return useMutation({
    mutationFn: (ids: string[]) => api.inbox.savedReplies.reorder(s.storeId!, ids),
    onMutate: (ids) => {
      qc.setQueriesData<{ data: InboxSavedReply[]; meta: unknown }>({ queryKey: inboxKeys.savedReplies(s) }, (prev) => {
        if (!prev) return prev;
        const byId = new Map(prev.data.map((r) => [r.id, r]));
        return { ...prev, data: ids.map((i) => byId.get(i)).filter((r): r is InboxSavedReply => !!r) };
      });
    },
    onSettled: () => void invalidate(),
  });
}

export function useRenderSavedReply(conversationId: string | null) {
  const s = useStoreScope();
  return useMutation({ mutationFn: (savedReplyId: string) => api.inbox.savedReplies.render(s.storeId!, conversationId!, savedReplyId) });
}

// ----- Channel settings (§4) -----
export function useInboxSettings(enabled = true) {
  const s = useStoreScope();
  return useQuery({ queryKey: inboxKeys.settings(s), queryFn: () => api.inbox.settings.get(s.storeId!), enabled: enabled && !!s.storeId, retry: false });
}

export function useUpdateInboxSettings() {
  const s = useStoreScope();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateInboxSettingsInput) => api.inbox.settings.update(s.storeId!, input),
    onSuccess: (settings) => {
      qc.setQueryData(inboxKeys.settings(s), settings);
      void qc.invalidateQueries({ queryKey: inboxKeys.summary(s) });
    },
    onError: () => void qc.invalidateQueries({ queryKey: inboxKeys.settings(s) }),
  });
}

export function useRotateEmailAddress() {
  const s = useStoreScope();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.inbox.settings.rotateEmailAddress(s.storeId!),
    onSuccess: (settings) => qc.setQueryData(inboxKeys.settings(s), settings),
  });
}

/** Order search for "Link an order" (needs `orders.view`). */
export function useOrderSearch(q: string, enabled: boolean) {
  const s = useStoreScope();
  return useQuery({
    queryKey: [s.tenantId, s.storeId, 'inbox', 'order-search', q] as const,
    queryFn: () => api.orders.list(s.storeId!, { q: q || undefined, per_page: 6 }),
    enabled: enabled && !!s.storeId,
    placeholderData: keepPreviousData,
    retry: false,
  });
}
