import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

/** Query keys for PHASE-8-9C help content (admin). */
export const helpKeys = {
  all: ['admin', 'help'] as const,
  articles: ['admin', 'help', 'articles'] as const,
  article: (id: string) => ['admin', 'help', 'articles', 'detail', id] as const,
  feedback: (id: string, helpful: boolean | undefined, page: number) => ['admin', 'help', 'articles', 'detail', id, 'feedback', helpful ?? 'all', page] as const,
  categories: ['admin', 'help', 'categories'] as const,
};

export function useHelpCategories(enabled = true) {
  return useQuery({ queryKey: helpKeys.categories, queryFn: () => api.admin.help.categories.list(), enabled, staleTime: 60_000 });
}
