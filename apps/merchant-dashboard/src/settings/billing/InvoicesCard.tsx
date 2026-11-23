import type { BillingInvoiceSummary } from '@storeplix/types';
import { Badge, Button, type BadgeTone, Pagination } from '@storeplix/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Download, FileText } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../../auth/AuthProvider';
import { saveFile } from '../../catalog/download';
import { ErrorBlock, LoadingRows } from '../../catalog/states';
import { api } from '../../lib/api';
import { toast } from '../../online-store/components/Toast';
import { billingKeys, formatDate, money } from '../../plan/billing';
import { useTenantStore } from '../../stores/useTenantStore';
import { SettingsCard } from '../SettingsLayout';

// Figma Card / Invoices 65:17616: table 65:17622 (INVOICE 150 · DATE 110 · DESCRIPTION flex · AMOUNT 100 · STATUS 90 ·
// 32px icon button), header surface-subtle Caption/12 Medium muted; rows py 12 px 16; billing details line 65:17716.
// 390 px: rows become stacked cards.

export function invoiceStatus(inv: Pick<BillingInvoiceSummary, 'status' | 'is_overdue'>): { label: string; tone: BadgeTone } {
  if (inv.status === 'paid') return { label: 'Paid', tone: 'success' };
  if (inv.status === 'void') return { label: 'Void', tone: 'neutral' };
  return inv.is_overdue ? { label: 'Overdue', tone: 'danger' } : { label: 'Open', tone: 'info' };
}

const PER_PAGE = 10;

export function InvoicesCard({ onPay }: { onPay: (invoice: BillingInvoiceSummary) => void }) {
  const { tenantId } = useAuth();
  const [page, setPage] = useState(1);
  const store = useTenantStore().data;
  const invoices = useQuery({
    queryKey: billingKeys.invoices(tenantId, page),
    queryFn: () => api.billing.invoices({ page, per_page: PER_PAGE }),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const first = invoices.data?.data[0];
  const latest = useQuery({ queryKey: billingKeys.invoice(tenantId, first?.id ?? ''), queryFn: () => api.billing.invoice(first!.id), enabled: !!first, retry: false, staleTime: 300_000 });
  const [downloading, setDownloading] = useState<string | null>(null);

  const download = async (inv: BillingInvoiceSummary) => {
    setDownloading(inv.id);
    try {
      saveFile(await api.billing.invoicePdf(inv.id, inv.number));
    } catch {
      toast('We couldn’t download the PDF. Try again.', 'error');
    } finally {
      setDownloading(null);
    }
  };

  const billTo = latest.data?.bill_to;
  const billToText = billTo ? [billTo.name, billTo.address].filter(Boolean).join(', ') : store?.name;
  const rows = invoices.data?.data ?? [];
  const meta = invoices.data?.meta;

  return (
    <SettingsCard title="Invoices" description="Download a PDF for your accounts. VAT-inclusive.">
      {invoices.isPending ? (
        <LoadingRows rows={3} label="Loading invoices" />
      ) : invoices.isError ? (
        <ErrorBlock error={invoices.error} title="We couldn’t load your invoices" onRetry={() => void invoices.refetch()} />
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-border-default px-6 py-8 text-center">
          <span className="flex size-10 items-center justify-center rounded-full bg-surface-subtle text-text-secondary">
            <FileText aria-hidden className="size-5" />
          </span>
          <p className="text-body font-medium text-text-primary">No invoices yet</p>
          <p className="text-caption text-text-secondary">Your Storeplix invoices appear here when you subscribe to a paid plan.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border-default">
          {/* One table for every width (390 px: each row is a 3-column grid card), so text exists once in the DOM. */}
          <table className="w-full">
            <thead className="bg-surface-subtle max-md:hidden">
              <tr className="text-left text-caption font-medium text-text-muted uppercase">
                <th scope="col" className="w-[150px] px-4 py-2.5 font-medium">Invoice</th>
                <th scope="col" className="w-[110px] px-3 py-2.5 font-medium">Date</th>
                <th scope="col" className="px-3 py-2.5 font-medium">Description</th>
                <th scope="col" className="w-[100px] px-3 py-2.5 font-medium">Amount</th>
                <th scope="col" className="w-[90px] px-3 py-2.5 font-medium">Status</th>
                <th scope="col" className="w-[120px] px-4 py-2.5">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((inv) => {
                const s = invoiceStatus(inv);
                return (
                  <tr key={inv.id} className="border-t border-border-default text-body first:max-md:border-t-0 max-md:grid max-md:grid-cols-[auto_1fr_auto] max-md:items-center max-md:gap-x-3 max-md:gap-y-1.5 max-md:px-4 max-md:py-3">
                    <td className="px-4 py-3 font-medium whitespace-nowrap text-text-primary max-md:order-1 max-md:col-span-2 max-md:p-0">{inv.number}</td>
                    <td className="px-3 py-3 whitespace-nowrap text-text-secondary max-md:order-4 max-md:p-0 max-md:text-caption">{formatDate(inv.issued_at)}</td>
                    <td className="px-3 py-3 text-text-primary max-md:order-3 max-md:col-span-3 max-md:p-0">{inv.description}</td>
                    <td className="px-3 py-3 font-semibold whitespace-nowrap text-text-primary max-md:order-5 max-md:p-0">{money(inv.total_amount)}</td>
                    <td className="px-3 py-3 max-md:order-2 max-md:justify-self-end max-md:p-0">
                      <Badge tone={s.tone} dot>
                        {s.label}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 max-md:order-6 max-md:p-0">
                      <div className="flex items-center justify-end gap-2">
                        {inv.can_pay && (
                          <Button size="sm" onClick={() => onPay(inv)}>
                            Pay
                          </Button>
                        )}
                        <DownloadButton inv={inv} busy={downloading === inv.id} onClick={() => void download(inv)} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {meta && meta.last_page > 1 && <Pagination page={meta.current_page} perPage={meta.per_page} total={meta.total} lastPage={meta.last_page} noun="invoices" onPage={setPage} />}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 text-caption">
        {billToText && <p className="min-w-0 flex-1 text-text-secondary">Invoices are issued to {billToText}.</p>}
        <Link to="/settings/store" className="font-medium text-brand-600 hover:text-brand-700">
          Edit billing details
        </Link>
      </div>
    </SettingsCard>
  );
}

function DownloadButton({ inv, busy, onClick }: { inv: BillingInvoiceSummary; busy: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Download ${inv.number} PDF`}
      disabled={busy}
      onClick={onClick}
      className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border-default bg-surface-card text-text-primary outline-none hover:bg-surface-subtle focus-visible:shadow-focus disabled:opacity-50"
    >
      <Download aria-hidden className="size-4" />
    </button>
  );
}
