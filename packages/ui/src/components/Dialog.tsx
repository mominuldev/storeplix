import type { ReactNode } from 'react';
import { Button } from './Button';
import { Modal } from './Modal';

// Confirmation dialog on top of Modal (Foundations 128:221 Overlay). Used for Discard / Delete / conflict reload.
export interface DialogProps {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string | null;
  tone?: 'primary' | 'danger';
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function Dialog({
  open,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'primary',
  loading = false,
  onConfirm,
  onCancel,
}: DialogProps) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      description={description}
      className="max-w-[440px]"
      footer={
        <>
          {cancelLabel && (
            <Button variant="secondary" onClick={onCancel} disabled={loading}>
              {cancelLabel}
            </Button>
          )}
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}
