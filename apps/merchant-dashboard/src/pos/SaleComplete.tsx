import type { PosSale } from '@storeplix/types';
import { Button, cn, formatBdt, Modal } from '@storeplix/ui';
import { useMutation } from '@tanstack/react-query';
import { Check, Phone, Printer } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useStoreScope } from '../catalog/scope';
import { errorMessage } from '../catalog/states';
import { api } from '../lib/api';
import { toast } from '../online-store/components/Toast';
import { handlePlanLimit } from '../plan/Banners';
import { PrintArea, ReceiptView } from './components';
import { paidInLabel, smsView } from './pos';
import { printPos } from './print';

// PHASE-8-8D §11.5 Sale complete 22:2241: check tile, "Sale complete", "Receipt {number} · paid in {method}", "Give
// change ৳ x" (cash), rows "Printed on 80 mm printer · Reprint" and "SMS receipt sent to {phone} · Resend" (sending /
// sent / failed / not sent), New sale (+ "Press Enter to start a new sale"); receipt preview (P88D-11). The barcode
// under the Figma receipt is not drawn (no barcode dependency; the number is printed).

export function SaleComplete({ sale, autoPrint, onNewSale }: { sale: PosSale; autoPrint: boolean; onNewSale: () => void }) {
  const scope = useStoreScope();
  const [current, setCurrent] = useState(sale);
  const [printed, setPrinted] = useState(false);
  const receipt = current.receipt;
  const phone = receipt.customer?.phone || null;

  // Print once the receipt has rendered into the print area (the timeout is cleared on unmount, so StrictMode's
  // double effect run still prints once).
  useEffect(() => {
    if (!autoPrint) return;
    const t = setTimeout(() => {
      printPos();
      setPrinted(true);
    }, 0);
    return () => clearTimeout(t);
  }, [autoPrint]);

  // "Press Enter to start a new sale".
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === 'Enter' && !(t && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName))) onNewSale();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onNewSale]);

  const resend = useMutation({
    mutationFn: () => api.pos.sales.smsReceipt(scope.storeId!, current.id),
    onSuccess: (next) =>
      setCurrent((c) => ({
        ...c,
        sms_receipt_status: next.sms_receipt_status,
      })),
    onError: (e) => {
      if (!handlePlanLimit(e)) toast(errorMessage(e, 'We couldn’t send the SMS receipt.'), 'error');
      setCurrent((c) => ({ ...c, sms_receipt_status: 'failed' }));
    },
  });
  const sms = smsView(current.sms_receipt_status, phone, resend.isPending);
  const cashChange = current.change_amount > 0;

  return (
    <Modal
      open
      onClose={onNewSale}
      title={<span className="sr-only">Sale complete</span>}
      size="xl"
      className="max-md:h-dvh max-md:max-h-dvh max-md:w-full max-md:max-w-none max-md:rounded-none"
    >
      <div className="-mx-6 -mb-6 grid md:grid-cols-[1fr_350px]" data-testid="pos-sale-complete">
        <div className="flex flex-col items-center gap-4 px-6 pb-6 text-center">
          <span className="flex size-[70px] items-center justify-center rounded-full bg-success-bg text-success">
            <Check aria-hidden className="size-8" />
          </span>
          <h2 className="text-heading-24 text-text-primary">Sale complete</h2>
          <p className="text-body text-text-secondary" data-testid="pos-receipt-number">
            Receipt {current.number} · paid in {paidInLabel(receipt.payments)}
          </p>
          {cashChange && (
            <div className="flex w-full flex-col items-center rounded-lg bg-success-bg py-4" data-testid="pos-give-change">
              <span className="text-body text-success">Give change</span>
              <span className="text-[40px] leading-[48px] font-bold text-success">{formatBdt(current.change_amount)}</span>
            </div>
          )}
          <div className="flex w-full items-center gap-3 rounded-lg border border-border-default px-4 py-3 text-left">
            <Printer aria-hidden className="size-5 text-text-secondary" />
            <span className="flex-1 text-body text-text-primary">{printed ? 'Printed on 80 mm printer' : 'Not printed'}</span>
            <button
              type="button"
              className="text-body font-medium text-brand-600 hover:underline"
              onClick={() => {
                printPos();
                setPrinted(true);
              }}
            >
              {printed ? 'Reprint' : 'Print'}
            </button>
          </div>
          <div className="flex w-full items-center gap-3 rounded-lg border border-border-default px-4 py-3 text-left" data-testid="pos-sms-row">
            <Phone aria-hidden className="size-5 text-text-secondary" />
            <span className={cn('flex-1 text-body', sms.tone === 'danger' ? 'text-danger' : 'text-text-primary')}>{sms.text}</span>
            {sms.action && (
              <button type="button" className="text-body font-medium text-brand-600 hover:underline" onClick={() => resend.mutate()}>
                {sms.action}
              </button>
            )}
          </div>
          <Button className="mt-2 min-h-12 w-full text-body-lg" onClick={onNewSale} data-testid="pos-new-sale" autoFocus>
            New sale
          </Button>
          <p className="text-caption text-text-muted">Press Enter to start a new sale</p>
        </div>
        <div className="flex justify-center bg-surface-subtle px-6 py-8 max-md:hidden">
          <ReceiptView receipt={receipt} className="shadow-elevation-1" />
        </div>
      </div>
      <PrintArea>
        <ReceiptView receipt={receipt} className="max-w-none p-2" />
      </PrintArea>
    </Modal>
  );
}
