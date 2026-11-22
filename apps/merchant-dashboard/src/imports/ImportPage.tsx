import { isApiError } from '@storeplix/api-client';
import type { DataImport, DataImportRow, DataImportType, ImportField, ImportOptions } from '@storeplix/types';
import { Badge, Button, cn, Dialog, FileDrop, Pagination, ProgressBar, Stepper, Toggle, type StepperStep } from '@storeplix/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronLeft, ChevronRight, FileText, Lock } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { formatBdt, formatCount, plural } from '../catalog/format';
import { useInvalidate } from '../catalog/queries';
import { keys, useStoreScope } from '../catalog/scope';
import { ErrorBlock, errorMessage, LoadingRows, NoResults, StateCard } from '../catalog/states';
import { FilterSelect } from '../catalog/ui';
import { saveFile } from '../catalog/download';
import { api } from '../lib/api';
import { Panel } from '../online-store/components/Shell';
import { toast } from '../online-store/components/Toast';
import { columnMapErrors, fieldLabels, pollInterval, wizardStep, type ColumnMap } from './fields';

// Figma Import products from CSV 60:10175 (Main 60:10177), Column map row 63:16638, Import preview row 63:16857.
// Contract §4 / §5: CSV only (Q30), "Download photos from image URLs" disabled (Q28), no inline fix — fix the file
// and re-upload. Also used for customers (`?type=customers`).

const MAX_BYTES = 10 * 1024 * 1024;
const defaultOptions: ImportOptions = { update_existing: true, import_as_draft: false, create_missing_categories: true };
type RowFilter = 'all' | 'error' | 'warning';

export function ImportPage() {
  const scope = useStoreScope();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const type: DataImportType = params.get('type') === 'customers' ? 'customers' : 'products';
  const fromOnboarding = params.get('from') === 'onboarding';
  const importId = params.get('import');
  const queryClient = useQueryClient();
  const invalidate = useInvalidate();
  const noun = type === 'products' ? 'products' : 'customers';
  const backTo = fromOnboarding ? '/onboarding/products' : type === 'products' ? '/products' : '/customers';

  const imp = useQuery({
    queryKey: keys.import(scope, importId),
    queryFn: () => api.imports.get(scope.storeId!, importId!),
    enabled: !!scope.storeId && !!importId,
    refetchInterval: (q) => pollInterval(q.state.data),
  });
  const data = importId ? imp.data : undefined;
  const step = wizardStep(data);

  const [map, setMap] = useState<ColumnMap>({});
  const [options, setOptions] = useState<ImportOptions>(defaultOptions);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limitMessage, setLimitMessage] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  // Seed the editable map/options from the server whenever the import or its status changes (suggested map first).
  const seedKey = data ? `${data.id}:${data.status}` : null;
  const [seeded, setSeeded] = useState<string | null>(null);
  if (data && seedKey !== seeded) {
    setSeeded(seedKey);
    setMap(data.column_map ?? data.suggested_map);
    setOptions({ ...defaultOptions, ...data.options });
  }

  // Completed → refresh the catalog/customers once.
  useEffect(() => {
    if (step === 'done') void (type === 'products' ? invalidate.afterProductSave() : invalidate.customers());
  }, [step, type]); // eslint-disable-line react-hooks/exhaustive-deps

  const setImport = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('import', id);
    else next.delete('import');
    setParams(next, { replace: true });
  };

  const setCache = (d: DataImport) => queryClient.setQueryData(keys.import(scope, d.id), d);

  const upload = async (file: File) => {
    setUploadError(null);
    setError(null);
    if (!/\.(csv|txt)$/i.test(file.name) && file.type && !/csv|text\/plain/.test(file.type)) {
      setUploadError('Save the file as CSV UTF-8 and try again.');
      return;
    }
    setUploadProgress(0);
    try {
      const d = await api.imports.upload(scope.storeId!, { file, type }, { onProgress: setUploadProgress });
      setCache(d);
      setImport(d.id);
    } catch (e) {
      if (isApiError(e) && e.code === 'import_in_progress') setUploadError('Another import is running. Wait for it to finish, then try again.');
      else if (isApiError(e) && e.status === 413) setUploadError('This file is over 10 MB. Split it into smaller files.');
      else setUploadError(isApiError(e) ? (e.fieldError('file') ?? e.message) : errorMessage(e));
    } finally {
      setUploadProgress(null);
    }
  };

  const mapErrors = useMemo(() => columnMapErrors(type, map), [type, map]);

  const validate = async () => {
    if (!data || mapErrors.length) return;
    setBusy(true);
    setError(null);
    try {
      setCache(await api.imports.validate(scope.storeId!, data.id, { column_map: map, options }));
    } catch (e) {
      setError(isApiError(e) && e.details ? Object.values(e.details).flat().join(' ') : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const run = async (allowPartial = false) => {
    if (!data) return;
    setBusy(true);
    setError(null);
    try {
      setCache(await api.imports.run(scope.storeId!, data.id, allowPartial ? { allow_partial: true } : {}));
      setLimitMessage(null);
    } catch (e) {
      if (isApiError(e) && e.code === 'plan_limit_reached') setLimitMessage(e.message);
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setConfirmCancel(false);
    if (data && (data.status === 'uploaded' || data.status === 'validated' || data.status === 'failed')) {
      try {
        await api.imports.cancel(scope.storeId!, data.id);
      } catch (e) {
        toast(errorMessage(e), 'error');
      }
    }
    setImport(null);
  };

  const download = async (kind: 'template' | 'errors') => {
    try {
      saveFile(kind === 'template' ? await api.imports.template(scope.storeId!, type) : await api.imports.errorReport(scope.storeId!, data!.id));
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  if (!scope.canBulkData) {
    return (
      <StateCard>
        <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-surface-subtle text-text-secondary">
            <Lock aria-hidden className="size-6" />
          </span>
          <h1 className="text-body-lg font-medium text-text-primary">Imports are for owners and managers</h1>
          <p className="text-body text-text-secondary">Ask a manager to import the spreadsheet for you.</p>
          <Link to={backTo} className="font-semibold text-brand-600">
            Go back
          </Link>
        </div>
      </StateCard>
    );
  }

  const summary = data?.summary;
  const steps: StepperStep[] = [
    { title: 'Upload file', hint: data ? data.filename : 'CSV UTF-8, up to 10 MB', state: data ? 'done' : 'current' },
    {
      title: 'Match columns',
      hint: data ? `${Object.values(map).filter(Boolean).length} of ${data.headers.length} matched` : undefined,
      state: !data ? 'upcoming' : step === 'map' || step === 'validating' ? 'current' : 'done',
    },
    {
      title: 'Review rows',
      hint: summary ? (summary.errors ? `${plural(summary.errors, 'error')} to fix` : 'All rows ready') : undefined,
      hintTone: summary?.errors ? 'danger' : 'muted',
      state: step === 'review' ? 'current' : step === 'importing' || step === 'done' ? 'done' : 'upcoming',
    },
    {
      title: 'Import',
      hint: summary ? `Add ${formatCount(summary.create)} · update ${formatCount(summary.update)}` : undefined,
      state: step === 'done' ? 'done' : step === 'importing' ? 'current' : 'upcoming',
    },
  ];

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-caption text-text-secondary">
            {fromOnboarding ? (
              <Link to={backTo} className="flex items-center gap-1 hover:text-text-primary">
                <ChevronLeft aria-hidden className="size-3" /> Back to setup
              </Link>
            ) : (
              <>
                <Link to={backTo} className="hover:text-text-primary">
                  {type === 'products' ? 'Products' : 'Customers'}
                </Link>
                <ChevronRight aria-hidden className="size-3" /> Import
              </>
            )}
          </nav>
          <h1 className="text-heading-24 text-text-primary">Import {noun} from CSV</h1>
          <p className="text-body text-text-secondary">
            {type === 'products' ? 'Bring products from a spreadsheet, Shopify or WooCommerce export.' : 'Bring customers from a spreadsheet or your old shop.'} Nothing changes until you press Import.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="secondary" onClick={() => void download('template')}>
            Download sample CSV
          </Button>
          {data && step !== 'done' && (
            <Button variant="ghost" disabled={step === 'validating' || step === 'importing'} onClick={() => setConfirmCancel(true)}>
              Cancel
            </Button>
          )}
        </div>
      </div>

      <div className="rounded-card border border-border-default bg-surface-card px-5 py-4 shadow-elevation-1">
        <Stepper steps={steps} label="Import steps" />
      </div>

      {error && (
        <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-body text-danger">
          {error}
        </p>
      )}

      {importId && imp.isPending ? (
        <StateCard>
          <LoadingRows label="Loading import" />
        </StateCard>
      ) : importId && imp.isError ? (
        <StateCard>
          <ErrorBlock error={imp.error} onRetry={() => void imp.refetch()} />
        </StateCard>
      ) : step === 'upload' ? (
        <Panel title="1 · Upload file" description="Excel? Use File › Save as › CSV UTF-8 (comma delimited). Bangla text is fine.">
          <FileDrop
            label={uploadProgress !== null ? `Uploading ${Math.round(uploadProgress * 100)}%` : 'Drop your CSV here or click to choose'}
            hint="CSV UTF-8 · up to 10 MB · 5,000 rows"
            accept=".csv,text/csv"
            maxBytes={MAX_BYTES}
            tooLargeMessage="This file is over 10 MB. Split it into smaller files."
            disabled={uploadProgress !== null}
            error={uploadError}
            onFiles={(files) => void upload(files[0]!)}
          />
          {uploadProgress !== null && <ProgressBar value={uploadProgress} label="Upload progress" />}
        </Panel>
      ) : step === 'failed' ? (
        <StateCard>
          <ErrorBlock title="This import didn’t finish" message={data?.failure_reason ?? 'Something went wrong while importing. Nothing after the last saved batch was changed.'} />
          <p className="pb-8 text-center text-body text-text-secondary">
            <button type="button" className="font-semibold text-brand-600" onClick={() => setImport(null)}>
              Upload again
            </button>
          </p>
        </StateCard>
      ) : step === 'done' && data ? (
        <ImportReport data={data} type={type} backTo={backTo} onAnother={() => setImport(null)} onErrors={() => void download('errors')} />
      ) : (
        data && (
          <>
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
              <div className="flex min-w-0 flex-col gap-5">
                <Panel
                  title="1 · File uploaded"
                  actions={
                    <Button size="sm" variant="secondary" disabled={step !== 'map' && step !== 'review'} onClick={() => setConfirmCancel(true)}>
                      Replace file
                    </Button>
                  }
                >
                  <div className="flex items-center gap-3 rounded-lg bg-surface-subtle p-3">
                    <span className="flex size-9 items-center justify-center rounded-md bg-success-bg text-success">
                      <FileText aria-hidden className="size-5" />
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-body font-semibold text-text-primary">{data.filename}</span>
                      <span className="text-caption text-text-muted">
                        {plural(data.row_count ?? 0, 'row')} · {Math.max(1, Math.round(data.size_bytes / 1024))} KB · UTF-8
                      </span>
                    </div>
                    <Badge tone="success" dot>
                      Read OK
                    </Badge>
                  </div>
                </Panel>
                <ColumnMapCard type={type} data={data} map={map} onChange={setMap} disabled={step !== 'map' && step !== 'review'} errors={mapErrors} onReset={() => setMap(data.suggested_map)} />
              </div>
              <ReadyCard
                type={type}
                data={data}
                step={step}
                options={options}
                onOptions={setOptions}
                busy={busy}
                mapDirty={JSON.stringify(map) !== JSON.stringify(data.column_map ?? null)}
                canValidate={!mapErrors.length}
                onValidate={() => void validate()}
                onRun={() => void run(false)}
              />
            </div>
            {(step === 'review' || step === 'importing') && <ReviewRows importId={data.id} total={summary?.total ?? data.row_count ?? 0} errors={summary?.errors ?? 0} warnings={summary?.warnings ?? 0} onErrorReport={() => void download('errors')} />}
          </>
        )
      )}

      <Dialog
        open={confirmCancel}
        title="Cancel this import?"
        description="Nothing has been imported yet. The uploaded file is deleted."
        confirmLabel="Cancel import"
        cancelLabel="Keep going"
        tone="danger"
        onCancel={() => setConfirmCancel(false)}
        onConfirm={() => void cancel()}
      />
      <Dialog
        open={!!limitMessage}
        title="Not all products fit your plan"
        description={`${limitMessage ?? ''} Import as many as fit now; the rest are marked as errors in the report.`}
        confirmLabel="Import as many as fit"
        cancelLabel="Upgrade first"
        loading={busy}
        onCancel={() => {
          setLimitMessage(null);
          navigate('/settings/plan');
        }}
        onConfirm={() => void run(true)}
      />
    </>
  );
}

function ColumnMapCard({ type, data, map, onChange, disabled, errors, onReset }: { type: DataImportType; data: DataImport; map: ColumnMap; onChange: (m: ColumnMap) => void; disabled: boolean; errors: string[]; onReset: () => void }) {
  const labels = fieldLabels(type);
  const matched = Object.values(map).filter(Boolean).length;
  return (
    <Panel
      title="2 · Match columns"
      description={`We matched ${matched} of ${data.headers.length} columns automatically. Check the ones in orange.`}
      actions={
        <button type="button" onClick={onReset} disabled={disabled} className="text-caption font-medium text-brand-600 disabled:opacity-50">
          Reset
        </button>
      }
    >
      <ul aria-label="Column matches" className="-mx-5 flex flex-col divide-y divide-border-default border-t border-border-default">
        {data.headers.map((h) => {
          const field = map[h] ?? null;
          const isImageUrls = field === 'image_urls';
          return (
            <li key={h} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:gap-3">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-body font-semibold text-text-primary">{h}</span>
                <span className="truncate text-caption text-text-muted">{data.samples[h] ? `e.g. ${data.samples[h]}` : 'Empty in the first rows'}</span>
              </span>
              <ChevronRight aria-hidden className="hidden size-4 text-text-muted sm:block" />
              <FilterSelect
                label={`Field for ${h}`}
                value={field ?? ''}
                disabled={disabled}
                onChange={(e) => onChange({ ...map, [h]: (e.target.value || null) as ImportField | null })}
                className={cn('w-full sm:w-48', !field && '[&_select]:border-warning')}
              >
                <option value="">Don’t import</option>
                {Object.entries(labels).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </FilterSelect>
              <span className={cn('flex w-28 items-center gap-1 text-caption font-medium', field && !isImageUrls ? 'text-success' : 'text-warning')}>
                <Check aria-hidden className="size-3.5" /> {isImageUrls ? 'Ignored for now' : field ? 'Matched' : 'Skipped'}
              </span>
            </li>
          );
        })}
      </ul>
      {errors.length > 0 && (
        <ul role="alert" className="flex flex-col gap-1 text-caption text-danger">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function ReadyCard({
  type,
  data,
  step,
  options,
  onOptions,
  busy,
  mapDirty,
  canValidate,
  onValidate,
  onRun,
}: {
  type: DataImportType;
  data: DataImport;
  step: string;
  options: ImportOptions;
  onOptions: (o: ImportOptions) => void;
  busy: boolean;
  mapDirty: boolean;
  canValidate: boolean;
  onValidate: () => void;
  onRun: () => void;
}) {
  const s = data.summary;
  const validated = step === 'review' && !mapDirty;
  const importable = s ? s.create + s.update - s.over_limit : 0;
  const noun = type === 'products' ? 'product' : 'customer';
  const opt = (key: keyof ImportOptions, title: string, hint: string) => (
    <div className="flex items-center justify-between gap-3">
      <span className="flex flex-col">
        <span className="text-body text-text-primary">{title}</span>
        <span className="text-caption text-text-muted">{hint}</span>
      </span>
      <Toggle label={title} checked={options[key]} disabled={step === 'validating' || step === 'importing'} onChange={(v) => onOptions({ ...options, [key]: v })} />
    </div>
  );
  return (
    <section aria-label="Ready to import" className="flex flex-col gap-4 rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-body-lg font-medium text-text-primary">{step === 'importing' ? 'Importing…' : validated ? 'Ready to import' : 'Check your rows'}</h2>
        <p className="text-caption text-text-muted">{s ? `${plural(s.total, 'row')} checked` : `${plural(data.row_count ?? 0, 'row')} in the file`}</p>
      </div>
      {s && (
        <dl className="flex flex-col gap-2">
          {[
            [`New ${noun}s`, s.create, 'bg-surface-subtle text-text-primary'],
            [type === 'products' ? 'Update existing (same SKU)' : 'Update existing (same phone/email)', s.update, 'bg-surface-subtle text-text-primary'],
            ['No changes', s.unchanged, 'bg-surface-subtle text-text-secondary'],
            ['Fixed for you (warnings)', s.warnings, 'bg-warning-bg text-warning'],
            ['Errors — will be skipped', s.errors, 'bg-danger-bg text-danger'],
            ...(s.over_limit ? [['Over your plan limit', s.over_limit, 'bg-danger-bg text-danger'] as const] : []),
          ].map(([label, n, cls]) => (
            <div key={label as string} className={cn('flex items-center justify-between rounded-md px-3 py-2.5', cls as string)}>
              <dt className="text-body">{label}</dt>
              <dd className="text-body-lg font-medium">{formatCount(n as number)}</dd>
            </div>
          ))}
        </dl>
      )}
      {(step === 'validating' || step === 'importing') && (
        <div className="flex flex-col gap-1.5">
          <ProgressBar value={data.progress.total ? data.progress.processed / data.progress.total : 0} label={step === 'validating' ? 'Checking rows' : 'Importing'} />
          <span className="text-caption text-text-muted">
            {step === 'validating' ? 'Checking' : 'Importing'} {formatCount(data.progress.processed)} of {formatCount(data.progress.total)} rows…
          </span>
        </div>
      )}
      <div className="flex flex-col gap-3">
        <span className="text-body font-medium text-text-primary">Options</span>
        {opt('update_existing', type === 'products' ? 'Update products with the same SKU' : 'Update customers with the same phone', type === 'products' ? 'Price, stock and details are replaced' : 'Filled cells replace current details')}
        {type === 'products' && opt('import_as_draft', 'Import as Draft', 'Review before buyers can see them')}
        {type === 'products' && opt('create_missing_categories', 'Create missing categories', 'Adds categories named in the file')}
        {type === 'products' && (
          <div className="flex items-center justify-between gap-3 opacity-60">
            <span className="flex flex-col">
              <span className="flex items-center gap-2 text-body text-text-primary">
                Download photos from image URLs <Badge>Coming soon</Badge>
              </span>
              <span className="text-caption text-text-muted">Add photos in the product editor for now</span>
            </span>
            <Toggle label="Download photos from image URLs" checked={false} disabled />
          </div>
        )}
      </div>
      {validated ? (
        <Button fullWidth loading={busy} disabled={importable <= 0} onClick={onRun}>
          Import {plural(Math.max(0, importable), noun)}
        </Button>
      ) : (
        <Button fullWidth loading={busy || step === 'validating'} disabled={!canValidate || step === 'importing'} onClick={onValidate}>
          {step === 'review' ? 'Check rows again' : 'Check rows'}
        </Button>
      )}
      <p className="text-caption text-text-muted">
        {s?.errors ? `${plural(s.errors, 'row')} with errors are skipped. Fix them in the file, then re-import.` : 'Nothing changes in your shop until you press Import.'}
      </p>
    </section>
  );
}

function ReviewRows({ importId, total, errors, warnings, onErrorReport }: { importId: string; total: number; errors: number; warnings: number; onErrorReport: () => void }) {
  const scope = useStoreScope();
  const [filter, setFilter] = useState<RowFilter>(errors ? 'error' : 'all');
  const [page, setPage] = useState(1);
  const rows = useQuery({
    queryKey: [...keys.importRows(scope, importId, filter), page],
    queryFn: () => api.imports.rows(scope.storeId!, importId, { status: filter === 'all' ? undefined : [filter], page, per_page: 25 }),
    enabled: !!scope.storeId,
  });
  const chips: [RowFilter, string][] = [
    ['all', `All ${formatCount(total)}`],
    ['error', `Errors ${formatCount(errors)}`],
    ['warning', `Warnings ${formatCount(warnings)}`],
  ];
  const meta = rows.data?.meta;
  return (
    <section aria-label="Review rows" className="overflow-hidden rounded-card border border-border-default bg-surface-card shadow-elevation-1">
      <div className="flex flex-wrap items-center gap-3 px-5 py-4">
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="text-body-lg font-medium text-text-primary">3 · Review rows</h2>
          <p className="text-caption text-text-muted">Fix problems in your file and upload it again.</p>
        </div>
        <div role="tablist" aria-label="Row filter" className="flex gap-2">
          {chips.map(([v, label]) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={filter === v}
              onClick={() => {
                setFilter(v);
                setPage(1);
              }}
              className={cn('rounded-full border px-3.5 py-1.5 text-body', filter === v ? 'border-brand-500 bg-brand-50 font-medium text-brand-700' : 'border-border-default text-text-secondary')}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {rows.isPending ? (
        <LoadingRows label="Loading rows" />
      ) : rows.isError ? (
        <ErrorBlock error={rows.error} onRetry={() => void rows.refetch()} />
      ) : rows.data.data.length === 0 ? (
        <NoResults title={filter === 'all' ? 'No rows' : `No ${filter === 'error' ? 'errors' : 'warnings'}`} description={filter === 'error' ? 'Every row can be imported.' : undefined} />
      ) : (
        <ul aria-label="Rows" className="divide-y divide-border-default border-t border-border-default">
          {rows.data.data.map((r) => (
            <ImportRow key={r.row_number} row={r} />
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2 border-t border-border-default px-5 py-3">
        <span className="min-w-0 flex-1 text-caption text-text-secondary">{meta ? `Showing ${formatCount(rows.data!.data.length)} of ${formatCount(meta.total)} rows` : ''}</span>
        {errors + warnings > 0 && (
          <Button size="sm" variant="secondary" onClick={onErrorReport}>
            Download error report
          </Button>
        )}
      </div>
      {meta && meta.last_page > 1 && <Pagination page={meta.current_page} perPage={meta.per_page} total={meta.total} lastPage={meta.last_page} noun="rows" onPage={setPage} />}
    </section>
  );
}

function ImportRow({ row }: { row: DataImportRow }) {
  const tone = row.status === 'error' ? 'danger' : row.status === 'warning' ? 'warning' : 'success';
  const label = row.status === 'error' ? 'Error' : row.status === 'warning' ? 'Fixed' : 'Ready';
  const message =
    row.messages.map((m) => m.message).join(' · ') ||
    (row.action === 'create' ? 'New' : row.action === 'update' ? 'Updates existing' : row.action === 'unchanged' ? 'No changes' : 'Skipped');
  return (
    <li className={cn('flex flex-col gap-2 px-5 py-3 md:flex-row md:items-center md:gap-4', row.status === 'error' && 'bg-danger-bg/60')}>
      <span className="w-14 shrink-0 text-caption text-text-muted">Row {row.row_number}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body font-semibold text-text-primary">{row.label || '—'}</span>
        <span className="truncate text-caption text-text-muted">
          {[row.key, row.preview.variants && row.preview.variants > 1 ? `${row.preview.variants} variants` : null].filter(Boolean).join(' · ')}
        </span>
      </span>
      {row.preview.price_amount !== null || row.preview.stock !== null ? (
        <span className="flex gap-6 md:w-40">
          <span className="w-20 text-body text-text-primary">{row.preview.price_amount !== null ? formatBdt(row.preview.price_amount) : '—'}</span>
          <span className={cn('text-body', row.preview.stock !== null && row.preview.stock < 0 ? 'text-danger' : 'text-text-primary')}>{row.preview.stock ?? '—'}</span>
        </span>
      ) : null}
      <span className="flex min-w-0 items-center gap-2 md:w-[340px]">
        <Badge tone={tone} dot>
          {label}
        </Badge>
        <span className={cn('truncate text-caption', row.status === 'ready' ? 'text-text-secondary' : row.status === 'warning' ? 'text-warning' : 'text-danger')}>{message}</span>
      </span>
    </li>
  );
}

function ImportReport({ data, type, backTo, onAnother, onErrors }: { data: DataImport; type: DataImportType; backTo: string; onAnother: () => void; onErrors: () => void }) {
  const s = data.summary;
  const noun = type === 'products' ? 'product' : 'customer';
  return (
    <Panel title="Import finished" description={data.completed_at ? `Done · ${new Date(data.completed_at).toLocaleString('en-GB')}` : undefined}>
      <dl className="grid gap-3 sm:grid-cols-4">
        {[
          ['Added', s?.create ?? 0],
          ['Updated', s?.update ?? 0],
          ['No changes', s?.unchanged ?? 0],
          ['Skipped (errors)', (s?.errors ?? 0) + (s?.over_limit ?? 0)],
        ].map(([label, n]) => (
          <div key={label as string} className="flex flex-col gap-1 rounded-lg bg-surface-subtle p-4">
            <dt className="text-caption text-text-muted">{label}</dt>
            <dd className="text-heading-24 text-text-primary">{formatCount(n as number)}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-2">
        <Link to={backTo} className="inline-flex min-h-10 items-center rounded-md bg-brand-600 px-4 text-body font-semibold text-text-inverse hover:bg-brand-700">
          {backTo.startsWith('/onboarding') ? 'Back to setup' : `See ${noun}s`}
        </Link>
        <Button variant="secondary" onClick={onAnother}>
          Import another file
        </Button>
        {(s?.errors ?? 0) + (s?.warnings ?? 0) > 0 && (
          <Button variant="ghost" onClick={onErrors}>
            Download error report
          </Button>
        )}
      </div>
    </Panel>
  );
}

export default ImportPage;
