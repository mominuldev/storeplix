import type { DocumentKind, StoreDocument } from '@storeplix/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { keys, useStoreScope } from '../catalog/scope';
import { errorMessage } from '../catalog/states';
import { useCommerceInvalidate } from '../commerce/queries';
import { api } from '../lib/api';
import { toast } from '../online-store/components/Toast';
import { documentKindLabels } from './labels';

// PHASE-5B P5B-53: POST /documents → 202 `queued`; poll GET /documents/{id} (query key `[…, 'document', id]`) every
// 1 s until `ready`, then open the 5-minute signed `download_url`. Printing marks the orders printed, so the orders
// queries are refreshed afterwards.

export const POLL_MS = 1000;
/** Give up after this many polls (the server job itself times out at 120 s). */
export const MAX_POLLS = 120;

export type PrintMode = 'open' | 'download';

const finalStatus = (s: StoreDocument['status']) => s === 'ready' || s === 'failed' || s === 'expired';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class PrintTimeout extends Error {}
class Unmounted extends Error {}

interface Vars {
  kind: DocumentKind;
  orderIds: string[];
  mode: PrintMode;
  /** Opened synchronously on click so the browser doesn't block the popup after the async wait. */
  win: Window | null;
  language?: 'en' | 'bn';
}

export function usePrintJob() {
  const scope = useStoreScope();
  const qc = useQueryClient();
  const invalidate = useCommerceInvalidate();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const job = useMutation({
    mutationFn: async (v: Vars) => {
      let doc = await api.documents.create(scope.storeId!, { kind: v.kind, order_ids: v.orderIds, ...(v.language ? { language: v.language } : {}) });
      for (let i = 0; !finalStatus(doc.status); i++) {
        if (i >= MAX_POLLS) throw new PrintTimeout();
        await sleep(POLL_MS);
        if (!mounted.current) throw new Unmounted();
        const id = doc.id;
        doc = await qc.fetchQuery({ queryKey: keys.document(scope, id), queryFn: () => api.documents.get(scope.storeId!, id), staleTime: 0 });
      }
      return doc;
    },
    onSuccess: (doc, v) => {
      if (doc.status !== 'ready' || !doc.download_url) {
        v.win?.close();
        toast(doc.status === 'expired' ? 'That PDF expired. Print again.' : 'We couldn’t make the PDF. Try again.', 'error');
        return;
      }
      if (v.mode === 'download') {
        const a = document.createElement('a');
        a.href = doc.download_url;
        a.download = '';
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
      } else if (v.win && !v.win.closed) {
        v.win.location.href = doc.download_url;
      } else {
        window.open(doc.download_url, '_blank', 'noopener');
      }
      toast(`${documentKindLabels[v.kind].noun(v.orderIds.length)} ready.`);
      void Promise.all(v.orderIds.map((id) => invalidate.afterOrderChange(id)));
    },
    onError: (e, v) => {
      v.win?.close();
      if (e instanceof Unmounted) return;
      toast(e instanceof PrintTimeout ? 'The PDF is taking too long. Try again in a minute.' : errorMessage(e, 'We couldn’t make the PDF.'), 'error');
    },
  });

  return {
    pending: job.isPending,
    kind: job.isPending ? (job.variables?.kind ?? null) : null,
    /** Call from a click handler. `open` mode opens a blank tab right away so popup blockers allow it. */
    start: (kind: DocumentKind, orderIds: string[], mode: PrintMode = 'open', language?: 'en' | 'bn') => {
      if (!orderIds.length || job.isPending) return;
      let win: Window | null = null;
      if (mode === 'open') {
        try {
          win = window.open('', '_blank');
          if (win) win.opener = null;
        } catch {
          win = null;
        }
      }
      job.mutate({ kind, orderIds: orderIds.slice(0, 100), mode, win, language });
    },
  };
}
