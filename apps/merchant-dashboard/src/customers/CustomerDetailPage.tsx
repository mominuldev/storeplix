import { isApiError } from '@storeplix/api-client';
import type { CustomerDetail } from '@storeplix/types';
import { Avatar, Badge, Button, buttonVariants, Dialog, KpiTile, TagInput } from '@storeplix/ui';
import { useMutation } from '@tanstack/react-query';
import { CreditCard, Mail, MapPin, MessageCircle, Phone, RefreshCw, ShoppingCart, Trash2, Truck } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { dateTime, formatIntlPhone, monthYear } from '../catalog/format';
import { useCustomer, useInvalidate } from '../catalog/queries';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, errorMessage, StateCard } from '../catalog/states';
import { iconButton } from '../catalog/ui';
import { api } from '../lib/api';
import { ConflictDialog, LoadingState, Panel } from '../online-store/components/Shell';
import { toast } from '../online-store/components/Toast';
import { channelLabels, CustomerFormDialog } from './CustomerFormDialog';

// Figma Customer detail 64:16382 (Main 64:16384). Contract §9.1: Contact, Tags, Notes, stat tiles ("—"),
// WhatsApp + Edit; O A can delete. SMS, Block, Create order, Addresses, cross-shop delivery record (Q23),
// Orders table, Lifetime value and message composer are not built.

export function waLink(msisdn: string): string {
  return `https://wa.me/${msisdn.replace(/\D/g, '')}`;
}

export function CustomerDetailPage() {
  const { customerId } = useParams();
  const query = useCustomer(customerId);
  if (query.isPending) return <LoadingState label="Loading customer" />;
  if (query.isError) {
    const notFound = isApiError(query.error) && query.error.status === 404;
    return (
      <StateCard>
        <ErrorBlock title={notFound ? 'Customer not found' : 'We couldn’t load this customer'} error={notFound ? undefined : query.error} onRetry={notFound ? undefined : () => void query.refetch()} />
        <p className="pb-8 text-center">
          <Link to="/customers" className="font-semibold text-brand-600">
            Back to customers
          </Link>
        </p>
      </StateCard>
    );
  }
  return <CustomerView customer={query.data} />;
}

function CustomerView({ customer }: { customer: CustomerDetail }) {
  const navigate = useNavigate();
  const scope = useStoreScope();
  const invalidate = useInvalidate();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [note, setNote] = useState('');
  const [conflict, setConflict] = useState(false);
  const storeId = scope.storeId!;

  const tags = useMutation({
    mutationFn: (next: string[]) => api.customers.update(storeId, customer.id, { tags: next, revision: customer.revision }),
    onSuccess: () => invalidate.customers(customer.id),
    onError: (e) => (isApiError(e) && e.code === 'revision_conflict' ? setConflict(true) : toast(errorMessage(e), 'error')),
  });
  const addNote = useMutation({
    mutationFn: () => api.customers.addNote(storeId, customer.id, note.trim()),
    onSuccess: async () => {
      setNote('');
      await invalidate.customers(customer.id);
    },
    onError: (e) => toast(isApiError(e) ? (e.fieldError('body') ?? e.message) : errorMessage(e), 'error'),
  });
  const deleteNote = useMutation({
    mutationFn: (noteId: string) => api.customers.deleteNote(storeId, customer.id, noteId),
    onSuccess: () => invalidate.customers(customer.id),
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const remove = useMutation({
    mutationFn: () => api.customers.delete(storeId, customer.id),
    onSuccess: async () => {
      toast(`Deleted ${customer.name}.`);
      await invalidate.customers();
      navigate('/customers', { replace: true });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  const meta = [`Customer since ${monthYear(customer.created_at)}`, customer.channel ? `came from ${channelLabels[customer.channel]}` : null, customer.source === 'import' ? 'imported' : null].filter(Boolean).join(' · ');

  return (
    <>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <Avatar name={customer.name} size="lg" className="bg-accent-100 text-accent-500" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <nav aria-label="Breadcrumb" className="text-caption text-text-secondary">
            <Link to="/customers" className="hover:text-text-primary">
              Customers
            </Link>{' '}
            / {customer.name}
          </nav>
          <h1 className="truncate text-heading-24 text-text-primary">{customer.name}</h1>
          <p className="text-body text-text-secondary">{meta}</p>
          {customer.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {customer.tags.map((t) => (
                <Badge key={t} tone="brand">
                  {t}
                </Badge>
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {customer.phone && (
            <a href={waLink(customer.phone)} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: 'secondary' })}>
              WhatsApp
            </a>
          )}
          <Button variant="secondary" onClick={() => setEditing(true)}>
            Edit
          </Button>
          {scope.canManageCatalog && (
            <Button variant="danger" leftIcon={<Trash2 aria-hidden className="size-4" />} onClick={() => setDeleting(true)}>
              Delete
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[340px_minmax(0,1fr)] lg:items-start">
        <div className="flex flex-col gap-5">
          <Panel
            title="Contact"
            actions={
              <button type="button" onClick={() => setEditing(true)} className="text-caption font-medium text-brand-600">
                Edit
              </button>
            }
          >
            <dl className="flex flex-col gap-4">
              {customer.phone && (
                <div className="flex items-center gap-3">
                  <span className={iconButton + ' size-9 border-0 bg-surface-subtle'}>
                    <Phone aria-hidden />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <dt className="text-caption text-text-muted">Phone</dt>
                    <dd className="text-body font-medium text-text-primary">{formatIntlPhone(customer.phone)}</dd>
                  </div>
                  <a href={`tel:+${customer.phone}`} aria-label="Call" className={iconButton}>
                    <Phone aria-hidden />
                  </a>
                  <a href={waLink(customer.phone)} target="_blank" rel="noopener noreferrer" aria-label="WhatsApp" className={iconButton}>
                    <MessageCircle aria-hidden />
                  </a>
                </div>
              )}
              {customer.email && (
                <div className="flex items-center gap-3">
                  <span className={iconButton + ' size-9 border-0 bg-surface-subtle'}>
                    <Mail aria-hidden />
                  </span>
                  <div className="flex min-w-0 flex-col">
                    <dt className="text-caption text-text-muted">Email</dt>
                    <dd className="truncate text-body font-medium text-text-primary">
                      <a href={`mailto:${customer.email}`} className="hover:text-brand-600">
                        {customer.email}
                      </a>
                    </dd>
                  </div>
                </div>
              )}
              <div className="flex items-center gap-3">
                <span className={iconButton + ' size-9 border-0 bg-surface-subtle'}>
                  <MapPin aria-hidden />
                </span>
                <div className="flex min-w-0 flex-col">
                  <dt className="text-caption text-text-muted">District</dt>
                  <dd className="text-body font-medium text-text-primary">{[customer.district, customer.area].filter(Boolean).join(' · ') || '—'}</dd>
                </div>
              </div>
            </dl>
          </Panel>

          <Panel title="Tags">
            <TagInput label="Customer tags" value={customer.tags} disabled={tags.isPending} onChange={(next) => tags.mutate(next)} placeholder="+ Add tag" />
          </Panel>

          <Panel title="Notes" description="Only your team can see these">
            <ul className="flex flex-col gap-3">
              {customer.notes.map((n) => (
                <li key={n.id} className="flex flex-col gap-1 rounded-lg bg-surface-subtle p-3">
                  <p className="text-body whitespace-pre-line text-text-primary">{n.body}</p>
                  <div className="flex items-center gap-2 text-caption text-text-muted">
                    <span className="flex-1">
                      {n.author?.name ?? 'Former teammate'} · {dateTime(n.created_at)}
                    </span>
                    {n.can_delete && (
                      <button type="button" aria-label="Delete note" disabled={deleteNote.isPending} onClick={() => deleteNote.mutate(n.id)} className="rounded-sm p-1 hover:text-danger">
                        <Trash2 aria-hidden className="size-3.5" />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (note.trim()) addNote.mutate();
              }}
            >
              <textarea
                aria-label="Add a note"
                placeholder="Add a note…"
                rows={2}
                maxLength={1000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="rounded-md border border-border-default px-3 py-2 text-body outline-none focus:border-brand-600"
              />
              {note.trim() && (
                <Button type="submit" size="sm" className="self-end" loading={addNote.isPending}>
                  Save note
                </Button>
              )}
            </form>
          </Panel>
        </div>

        <section aria-label="Order stats" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KpiTile icon={<CreditCard />} label="Total spent" value="—" hint="Starts with the first order" />
          <KpiTile icon={<ShoppingCart />} label="Avg order" value="—" hint="Starts with the first order" />
          <KpiTile icon={<Truck />} label="Delivered" value="—" hint="Starts with the first order" />
          <KpiTile icon={<RefreshCw />} label="Returns cost" value="—" hint="Starts with the first order" />
        </section>
      </div>

      <CustomerFormDialog open={editing} customer={customer} onClose={() => setEditing(false)} />
      <Dialog
        open={deleting}
        tone="danger"
        title={`Delete ${customer.name}?`}
        description="Their contact details and notes are removed from your customer list."
        confirmLabel="Delete customer"
        loading={remove.isPending}
        onCancel={() => setDeleting(false)}
        onConfirm={() => remove.mutate()}
      />
      <ConflictDialog
        open={conflict}
        onReload={() => {
          setConflict(false);
          void invalidate.customers(customer.id);
        }}
      />
    </>
  );
}

export default CustomerDetailPage;
