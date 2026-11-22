import type { ReactNode } from 'react';
import { Button } from './Button';
import { Modal, type ModalProps } from './Modal';

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
  /** Disable the confirm button (e.g. until a form is valid). */
  confirmDisabled?: boolean;
  /** Submit this form id instead of calling onConfirm directly (Enter submits; onConfirm is not called). */
  formId?: string;
  size?: ModalProps['size'];
  footerStart?: ReactNode;
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
  confirmDisabled = false,
  formId,
  size = 'sm',
  footerStart,
  onConfirm,
  onCancel,
}: DialogProps) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      description={description}
      size={size}
      footerStart={footerStart}
      footer={
        <>
          {cancelLabel && (
            <Button variant="secondary" onClick={onCancel} disabled={loading}>
              {cancelLabel}
            </Button>
          )}
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            type={formId ? 'submit' : 'button'}
            form={formId}
            onClick={formId ? undefined : onConfirm}
            loading={loading}
            disabled={confirmDisabled}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}
