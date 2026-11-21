import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';

/** Opens a signed preview of a draft store in a new tab (contract D2). */
export function usePreviewStore() {
  return useMutation({
    mutationFn: async (storeId: string) => {
      // Open synchronously inside the click so popup blockers allow it, then navigate once the URL is known.
      const tab = window.open('about:blank', '_blank');
      try {
        const { url } = await api.stores.createPreviewToken(storeId);
        if (tab) {
          tab.opener = null;
          tab.location.href = url;
        } else {
          window.open(url, '_blank', 'noopener');
        }
        return url;
      } catch (error) {
        tab?.close();
        throw error;
      }
    },
  });
}
