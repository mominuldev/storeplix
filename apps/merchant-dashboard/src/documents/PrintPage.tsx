import { isApiError } from '@storeplix/api-client';
import type { DocumentKind, DocumentTemplate, DocumentTemplateConfig, OrderListFilters } from '@storeplix/types';
import { Button, Checkbox, cn, SegmentedControl, Toggle } from '@storeplix/ui';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ChevronLeft, ChevronRight, FileText } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { formatBdt, formatCount } from '../catalog/format';
import { keys, useStoreScope } from '../catalog/scope';
import { ErrorBlock, errorMessage, LoadingRows } from '../catalog/states';
import { useDebounced } from '../catalog/ui';
import { useOrders } from '../commerce/queries';
import { PageHeader } from '../layout/PageHeader';
import { api } from '../lib/api';
import { toast } from '../online-store/components/Toast';
import { documentKindLabels, documentKinds, printedKey } from './labels';
import { usePrintJob } from './usePrintJob';

// Figma Invoices & labels 39:10790 (templates 44:16156). Contract §10: Ready to print list (Not printed / Printed
// today), template cards, live preview (sanitised HTML in an iframe with `sandbox=""`), print settings saved to the
// template (O A), Print N and Download PDF. Not built: printer select (browser print dialog instead), Edit templates
// link, product thumbnails (OrderSummary has no item images).

type Tab = 'not_printed' | 'printed';
const PREVIEW_DEBOUNCE_MS = 400;
const courierName: Record<string, string> = { steadfast: 'Steadfast', pathao: 'Pathao', redx: 'RedX', manual: 'Own courier' };

function useDocumentTemplates() {
  const s = useStoreScope();
  return useQuery({ queryKey: keys.documentTemplates(s), queryFn: () => api.documents.templates(s.storeId!), enabled: !!s.storeId, staleTime: 60_000 });
}

export function PrintPage() {
  const scope = useStoreScope();
  const qc = useQueryClient();
  const [kind, setKind] = useState<DocumentKind>('label_4x6');
  const [tab, setTab] = useState<Tab>('not_printed');
  const [selected, setSelected] = useState<string[] | null>(null); // null = all rows on the tab
  const [page, setPage] = useState(0);
  const printed = printedKey(kind);
  const print = usePrintJob();

  const notPrintedFilters: OrderListFilters = { status: ['confirmed', 'ready_to_ship'], not_printed: printed, sort: '-placed_at', per_page: 100 };
  const printedFilters: OrderListFilters = { printed, sort: '-placed_at', per_page: 100 };
  const notPrinted = useOrders(notPrintedFilters);
  const printedToday = useOrders(printedFilters);
  const list = tab === 'not_printed' ? notPrinted : printedToday;
  const rows = useMemo(() => list.data?.data ?? [], [list.data]);
  const chosen = selected === null ? rows.map((r) => r.id) : selected.filter((id) => rows.some((r) => r.id === id));
  const chosenRows = rows.filter((r) => chosen.includes(r.id));
  const codSum = chosenRows.reduce((s, r) => s + r.due_amount, 0);
  const allChecked = rows.length > 0 && chosen.length === rows.length;

  const templates = useDocumentTemplates();
  const template = templates.data?.find((t) => t.kind === kind);
  const save = useMutation({
    mutationFn: (next: { t: DocumentTemplate; config: DocumentTemplateConfig }) => api.documents.saveTemplate(scope.storeId!, next.t.kind, { revision: next.t.revision, config: next.config }),
    onMutate: ({ t, config }) => {
      qc.setQueryData<DocumentTemplate[]>(keys.documentTemplates(scope), (old) => old?.map((x) => (x.kind === t.kind ? { ...x, config } : x)));
    },
    onSuccess: (saved) => qc.setQueryData<DocumentTemplate[]>(keys.documentTemplates(scope), (old) => old?.map((x) => (x.kind === saved.kind ? saved : x))),
    onError: (e) => {
      void qc.invalidateQueries({ queryKey: keys.documentTemplates(scope) });
      toast(isApiError(e) && e.code === 'revision_conflict' ? 'Someone else changed these settings. We reloaded them.' : errorMessage(e, 'We couldn’t save the print settings.'), 'error');
    },
  });
  const setConfig = (patch: Partial<DocumentTemplateConfig>) => template && save.mutate({ t: template, config: { ...template.config, ...patch } });

  const safePage = Math.min(page, Math.max(0, chosenRows.length - 1));
  const previewOrder = chosenRows[safePage] ?? null;
  const rawPreviewKey = JSON.stringify({ kind, config: template?.config ?? null, order_id: previewOrder?.id ?? null });
  const previewKey = useDebounced(rawPreviewKey, PREVIEW_DEBOUNCE_MS);
  const preview = useQuery({
    queryKey: [scope.tenantId, scope.storeId, 'document-preview', previewKey],
    queryFn: ({ signal }) => {
      const p = JSON.parse(previewKey) as { kind: DocumentKind; config: DocumentTemplateConfig | null; order_id: string | null };
      return api.documents.preview(scope.storeId!, { kind: p.kind, ...(p.config ? { config: p.config } : {}), order_id: p.order_id }, { signal });
    },
    // Only once the list has loaded and the input settled (the endpoint is throttled at 30/min).
    enabled: !!scope.storeId && !!template && !list.isPending && previewKey === rawPreviewKey,
    retry: false,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });

  const labels = documentKindLabels[kind];
  const n = chosen.length;
  const printLabel = `Print ${formatCount(n)} ${labels.noun(n).replace(/^[\d,]+ /, '')}`;
  const actions = (
    <>
      <Button variant="secondary" disabled={!n || n > 100} onClick={() => print.start(kind, chosen, 'download')}>
        Download PDF
      </Button>
      <Button disabled={!n || n > 100} loading={print.pending} onClick={() => print.start(kind, chosen, 'open')}>
        {printLabel}
      </Button>
    </>
  );

  return (
    <>
      <PageHeader title="Invoices & labels" subtitle="Pick orders, choose a template and print. Labels carry the COD amount so riders collect the right money." actions={actions} />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[340px_minmax(0,1fr)] xl:items-start">
        <Panel
          title="Ready to print"
          label="Ready to print"
          actions={rows.length > 0 && <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-caption font-medium text-brand-700">{`${formatCount(n)} of ${formatCount(rows.length)} selected`}</span>}
        >
          <SegmentedControl
            aria-label="Printed"
            value={tab}
            onChange={(v) => {
              setTab(v);
              setSelected(null);
            }}
            options={[
              { value: 'not_printed', label: `Not printed${notPrinted.data ? ` · ${formatCount(notPrinted.data.meta.total)}` : ''}` },
              { value: 'printed', label: `Printed today${printedToday.data ? ` · ${formatCount(printedToday.data.meta.total)}` : ''}` },
            ]}
          />
          {list.isPending ? (
            <LoadingRows rows={4} label="Loading orders" />
          ) : list.isError ? (
            <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
          ) : rows.length === 0 ? (
            <p className="px-2 py-8 text-center text-body text-text-secondary">{tab === 'not_printed' ? 'Nothing waiting. Confirmed orders show up here.' : 'Nothing printed today yet.'}</p>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3 border-b border-border-default pb-3">
                <Checkbox label={`Select all ${formatCount(rows.length)}`} checked={allChecked} onChange={(e) => setSelected(e.target.checked ? null : [])} />
                <span className="text-caption text-text-secondary">COD {formatBdt(codSum)}</span>
              </div>
              <ul aria-label="Orders to print" className="flex flex-col gap-2">
                {rows.map((o) => {
                  const on = chosen.includes(o.id);
                  return (
                    <li key={o.id}>
                      <label className={cn('flex cursor-pointer items-center gap-3 rounded-lg border p-3', on ? 'border-brand-600 bg-brand-50' : 'border-border-default')}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${o.number}`}
                          checked={on}
                          onChange={(e) => setSelected(e.target.checked ? [...chosen, o.id] : chosen.filter((x) => x !== o.id))}
                          className="size-4 accent-brand-600"
                        />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="text-body font-semibold text-text-primary">{o.number}</span>
                          <span className="truncate text-caption text-text-muted">
                            {[o.shipment ? courierName[o.shipment.provider] : null, o.customer.name, `${formatCount(o.items_count)} ${o.items_count === 1 ? 'item' : 'items'}`].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                        <span className="text-body font-semibold text-text-primary">{o.due_amount > 0 ? formatBdt(o.due_amount) : 'Prepaid'}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              {n > 100 && <p className="text-caption text-danger">Print up to 100 at a time.</p>}
            </>
          )}
        </Panel>

        <div className="flex min-w-0 flex-col gap-5">
          <Panel title="Template" label="Template">
            <div role="radiogroup" aria-label="Template" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {documentKinds.map((k) => {
                const on = k === kind;
                return (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setKind(k)}
                    className={cn('flex flex-col gap-2 rounded-lg border p-3 text-left', on ? 'border-brand-600 bg-brand-50' : 'border-border-default hover:bg-surface-subtle')}
                  >
                    <span className="flex h-16 items-center justify-center rounded-md bg-surface-subtle text-text-muted">
                      <FileText aria-hidden className="size-7" />
                    </span>
                    <span className={cn('flex items-center gap-1 text-body font-semibold', on ? 'text-brand-700' : 'text-text-primary')}>
                      {documentKindLabels[k].name}
                      {on && <CheckCircle2 aria-hidden className="size-4" />}
                    </span>
                    <span className="text-caption text-text-muted">{documentKindLabels[k].paper}</span>
                  </button>
                );
              })}
            </div>
          </Panel>

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_280px] lg:items-start">
            <Panel
              title="Live preview"
              label="Live preview"
              subtitle={`${labels.name} · ${template?.paper.label ?? labels.paper}${previewOrder ? ` · ${previewOrder.number}` : ' · sample order'}`}
              actions={
                chosenRows.length > 1 && (
                  <span className="flex shrink-0 items-center gap-1 text-body whitespace-nowrap text-text-secondary">
                    <button type="button" aria-label="Previous" disabled={safePage === 0} onClick={() => setPage(safePage - 1)} className="rounded p-1 disabled:opacity-40">
                      <ChevronLeft aria-hidden className="size-4" />
                    </button>
                    {`${kind === 'label_4x6' ? 'Label' : 'Page'} ${safePage + 1} of ${chosenRows.length}`}
                    <button type="button" aria-label="Next" disabled={safePage >= chosenRows.length - 1} onClick={() => setPage(safePage + 1)} className="rounded p-1 disabled:opacity-40">
                      <ChevronRight aria-hidden className="size-4" />
                    </button>
                  </span>
                )
              }
            >
              <div className="flex min-h-[420px] items-start justify-center rounded-lg bg-surface-subtle p-4">
                {preview.data ? (
                  <iframe title="Document preview" sandbox="" srcDoc={preview.data.html} className="h-[560px] w-full max-w-[460px] rounded-md border border-border-default bg-white shadow-elevation-1" />
                ) : preview.isError ? (
                  <ErrorBlock title="We couldn’t load the preview" error={preview.error} onRetry={() => void preview.refetch()} />
                ) : (
                  <span className="py-16 text-caption text-text-muted">Loading preview…</span>
                )}
              </div>
            </Panel>

            <Panel title="Print settings" label="Print settings">
              {templates.isError ? (
                <ErrorBlock error={templates.error} onRetry={() => void templates.refetch()} />
              ) : !template ? (
                <LoadingRows rows={3} label="Loading settings" />
              ) : (
                <TemplateSettings template={template} disabled={!scope.canManageSettings} onChange={setConfig} />
              )}
              <div className="flex flex-col gap-2 border-t border-border-default pt-4">{actions}</div>
              <p className="text-caption text-text-muted">Printed orders move to “Printed today”. Use your browser’s print dialog to pick the printer.</p>
            </Panel>
          </div>
        </div>
      </div>
    </>
  );
}

function TemplateSettings({ template, disabled, onChange }: { template: DocumentTemplate; disabled: boolean; onChange: (p: Partial<DocumentTemplateConfig>) => void }) {
  const c = template.config;
  const label = template.kind === 'label_4x6';
  return (
    <div className="flex flex-col gap-4">
      {disabled && <p className="rounded-md bg-surface-subtle px-3 py-2 text-caption text-text-secondary">Only owners and managers can change print settings.</p>}
      <SettingRow title="Show shop logo">
        <Toggle label="Show shop logo" checked={c.show_logo} disabled={disabled} onChange={(v) => onChange({ show_logo: v })} />
      </SettingRow>
      <SettingRow title="Show BIN / VAT number" hint="Set the BIN in Settings → Taxes & invoices">
        <Toggle label="Show BIN / VAT number" checked={c.show_bin} disabled={disabled} onChange={(v) => onChange({ show_bin: v })} />
      </SettingRow>
      <SettingRow title="Show product names">
        <Toggle label="Show product names" checked={c.show_product_names} disabled={disabled} onChange={(v) => onChange({ show_product_names: v })} />
      </SettingRow>
      {!label && (
        <SettingRow title="Show prices">
          <Toggle label="Show prices" checked={c.show_prices} disabled={disabled} onChange={(v) => onChange({ show_prices: v })} />
        </SettingRow>
      )}
      <SettingRow title="Show SKU">
        <Toggle label="Show SKU" checked={c.show_sku} disabled={disabled} onChange={(v) => onChange({ show_sku: v })} />
      </SettingRow>
      <div className="flex flex-col gap-1.5">
        <span className="text-body font-medium text-text-primary">Language</span>
        <SegmentedControl
          aria-label="Language"
          value={c.language}
          disabled={disabled}
          onChange={(v) => onChange({ language: v })}
          options={[
            { value: 'en', label: 'English' },
            { value: 'bn', label: 'বাংলা' },
          ]}
        />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-body font-medium text-text-primary">Paper size</span>
        <span className="text-body text-text-secondary">{template.paper.label}</span>
      </div>
    </div>
  );
}

function SettingRow({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex min-w-0 flex-col">
        <span className="text-body text-text-primary">{title}</span>
        {hint && <span className="text-caption text-text-muted">{hint}</span>}
      </span>
      {children}
    </div>
  );
}

function Panel({ title, subtitle, actions, label, children }: { title: string; subtitle?: string; actions?: ReactNode; label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="flex min-w-0 flex-col gap-4 rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <h2 className="text-body-lg font-semibold text-text-primary">{title}</h2>
          {subtitle && <span className="truncate text-caption text-text-muted">{subtitle}</span>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export default PrintPage;
