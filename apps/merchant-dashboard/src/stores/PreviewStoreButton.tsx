import type { Store } from '@storeplix/types';
import { Button, type ButtonProps } from '@storeplix/ui';
import { Eye } from 'lucide-react';
import { usePreviewStore } from './usePreviewStore';

/** "Preview store" for draft stores (contract D2): signed 60-min link opened in a new tab. */
export function PreviewStoreButton({ store, ...props }: { store: Pick<Store, 'id' | 'status'> } & Omit<ButtonProps, 'onClick'>) {
  const preview = usePreviewStore();
  if (store.status !== 'draft') return null;
  return (
    <Button
      variant="secondary"
      leftIcon={<Eye aria-hidden className="size-4" />}
      loading={preview.isPending}
      onClick={() => preview.mutate(store.id)}
      title={preview.isError ? 'Could not create a preview link. Try again.' : undefined}
      {...props}
    >
      Preview store
    </Button>
  );
}
