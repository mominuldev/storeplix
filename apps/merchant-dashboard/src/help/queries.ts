import type { UploadOptions } from '@storeplix/api-client';
import type {
  CreateSupportTicketInput,
  HelpArticle,
  HelpFeedbackInput,
  HelpLanguage,
  HelpSearchFilters,
  RateSupportTicketInput,
  ReplySupportTicketInput,
  SupportTicket,
  SupportTicketFilters,
} from '@storeplix/types';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthProvider';
import { api } from '../lib/api';
import { canContactSupport } from './help';

// PHASE-8-9C §13 server state. Tenant-level keys: ['help', tenantId, …] (no store; guides are read per member,
// tickets per tenant).

export const helpKeys = {
  all: (t: string | null) => ['help', t] as const,
  home: (t: string | null, lang: HelpLanguage) => ['help', t, 'home', lang] as const,
  category: (t: string | null, slug: string, lang: HelpLanguage) => ['help', t, 'category', slug, lang] as const,
  search: (t: string | null, f: Omit<HelpSearchFilters, 'page'>) => ['help', t, 'search', f] as const,
  article: (t: string | null, slug: string, lang: HelpLanguage) => ['help', t, 'article', slug, lang] as const,
  tickets: (t: string | null) => ['help', t, 'tickets'] as const,
  ticketList: (t: string | null, f: SupportTicketFilters) => ['help', t, 'tickets', 'list', f] as const,
  ticket: (t: string | null, id: string) => ['help', t, 'tickets', 'detail', id] as const,
  messages: (t: string | null, id: string) => ['help', t, 'tickets', 'messages', id] as const,
};

export function useHelpHome(lang: HelpLanguage) {
  const { tenantId } = useAuth();
  return useQuery({ queryKey: helpKeys.home(tenantId, lang), queryFn: () => api.help.home(lang), enabled: !!tenantId, retry: false, staleTime: 60_000 });
}

export function useHelpCategory(slug: string, lang: HelpLanguage) {
  const { tenantId } = useAuth();
  return useQuery({ queryKey: helpKeys.category(tenantId, slug, lang), queryFn: () => api.help.category(slug, lang), enabled: !!tenantId && !!slug, retry: false });
}

/** §6 search, 20 per page; "Show more" loads the next page. */
export function useHelpSearch(f: Omit<HelpSearchFilters, 'page'>, enabled: boolean) {
  const { tenantId } = useAuth();
  return useInfiniteQuery({
    queryKey: helpKeys.search(tenantId, f),
    queryFn: ({ pageParam }) => api.help.search({ ...f, page: pageParam }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.meta.current_page < last.meta.last_page ? last.meta.current_page + 1 : undefined),
    enabled: enabled && !!tenantId,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useHelpArticle(slug: string, lang: HelpLanguage) {
  const { tenantId } = useAuth();
  return useQuery({ queryKey: helpKeys.article(tenantId, slug, lang), queryFn: () => api.help.article(slug, lang), enabled: !!tenantId && !!slug, retry: false });
}

/** PUT / DELETE feedback; the article cache is patched with the new vote and yes count. */
export function useArticleVote(article: Pick<HelpArticle, 'slug' | 'requested_language'>) {
  const { tenantId } = useAuth();
  const qc = useQueryClient();
  const key = helpKeys.article(tenantId, article.slug, article.requested_language);
  const patch = (fn: (a: HelpArticle) => HelpArticle) => qc.setQueryData<HelpArticle>(key, (a) => (a ? fn(a) : a));
  const vote = useMutation({
    mutationFn: (input: HelpFeedbackInput) => api.help.vote(article.slug, input),
    onSuccess: (myVote) =>
      patch((a) => {
        const before = a.helpful.my_vote?.helpful === true ? 1 : 0;
        const after = myVote.helpful ? 1 : 0;
        return { ...a, helpful: { yes_count: Math.max(0, a.helpful.yes_count - before + after), my_vote: myVote } };
      }),
  });
  const unvote = useMutation({
    mutationFn: () => api.help.unvote(article.slug),
    onSuccess: () => patch((a) => ({ ...a, helpful: { yes_count: Math.max(0, a.helpful.yes_count - (a.helpful.my_vote?.helpful ? 1 : 0)), my_vote: null } })),
  });
  return { vote, unvote };
}

// ----- Tickets (support.manage) -----
export function useTicketList(f: SupportTicketFilters) {
  const { tenantId, activeTenant } = useAuth();
  return useQuery({
    queryKey: helpKeys.ticketList(tenantId, f),
    queryFn: () => api.help.tickets.list(f),
    enabled: !!tenantId && canContactSupport(activeTenant),
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useTicket(id: string) {
  const { tenantId } = useAuth();
  return useQuery({ queryKey: helpKeys.ticket(tenantId, id), queryFn: () => api.help.tickets.get(id), enabled: !!tenantId && !!id, retry: false });
}

/** §13: polls every 30 s while the tab is visible (plain GET). */
export function useTicketMessages(id: string, enabled = true) {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: helpKeys.messages(tenantId, id),
    queryFn: () => api.help.tickets.messages(id),
    enabled: enabled && !!tenantId && !!id,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    retry: false,
  });
}

function useSetTicket() {
  const { tenantId } = useAuth();
  const qc = useQueryClient();
  return (t: SupportTicket) => {
    qc.setQueryData(helpKeys.ticket(tenantId, t.id), t);
    void qc.invalidateQueries({ queryKey: [...helpKeys.tickets(tenantId), 'list'] });
  };
}

export function useCreateTicket() {
  const { tenantId } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSupportTicketInput) => api.help.tickets.create(input),
    onSuccess: (t) => {
      qc.setQueryData(helpKeys.ticket(tenantId, t.id), t);
      void qc.invalidateQueries({ queryKey: helpKeys.tickets(tenantId) });
    },
  });
}

export function useReplyTicket(id: string) {
  const { tenantId } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ReplySupportTicketInput) => api.help.tickets.reply(id, input),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: helpKeys.messages(tenantId, id) }),
        qc.invalidateQueries({ queryKey: helpKeys.ticket(tenantId, id) }),
        qc.invalidateQueries({ queryKey: [...helpKeys.tickets(tenantId), 'list'] }),
      ]),
  });
}

export function useResolveTicket(id: string) {
  const { tenantId } = useAuth();
  const qc = useQueryClient();
  const setTicket = useSetTicket();
  return useMutation({
    mutationFn: () => api.help.tickets.resolve(id),
    onSuccess: (t) => {
      setTicket(t);
      void qc.invalidateQueries({ queryKey: helpKeys.messages(tenantId, id) });
    },
  });
}

export function useRateTicket(id: string) {
  const setTicket = useSetTicket();
  return useMutation({ mutationFn: (input: RateSupportTicketInput) => api.help.tickets.rate(id, input), onSuccess: setTicket });
}

export function useUploadSupportAttachment() {
  return useMutation({ mutationFn: (v: { file: File; opts?: UploadOptions }) => api.help.uploadAttachment({ file: v.file }, v.opts) });
}
