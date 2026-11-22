import type { CreateExportInput, DataExport } from '@storeplix/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../catalog/states';
import { useStoreScope } from '../catalog/scope';
import { api } from '../lib/api';
import { toast } from '../online-store/components/Toast';

const POLL_MS = 2000;
const MAX_POLLS = 150; // 5 minutes

/** Contract §9.2: POST /exports, poll until `completed`, then open the signed URL in the same tab (attachment). */
export function useExport(navigate: (url: string) => void = (url) => window.location.assign(url)) {
  const { storeId } = useStoreScope();
  const [running, setRunning] = useState(false);
  const alive = useRef(true);
  // StrictMode mounts twice: set the flag on every mount, clear it on unmount.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const start = useCallback(
    async (input: CreateExportInput) => {
      if (!storeId || running) return;
      setRunning(true);
      toast('Preparing your CSV… it downloads automatically.');
      try {
        let exp: DataExport = await api.exports.create(storeId, input);
        for (let i = 0; i < MAX_POLLS && alive.current && (exp.status === 'queued' || exp.status === 'running'); i++) {
          await new Promise((r) => setTimeout(r, POLL_MS));
          exp = await api.exports.get(storeId, exp.id);
        }
        if (!alive.current) return;
        if (exp.status === 'completed' && exp.download_url) navigate(exp.download_url);
        else toast(exp.status === 'failed' ? 'The export failed. Try again.' : 'The export is taking longer than usual. Try again in a minute.', 'error');
      } catch (e) {
        toast(errorMessage(e, 'The export failed. Try again.'), 'error');
      } finally {
        if (alive.current) setRunning(false);
      }
    },
    [storeId, running, navigate],
  );

  return { start, running };
}
