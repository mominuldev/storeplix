import { zodResolver } from '@hookform/resolvers/zod';
import { isApiError } from '@storeplix/api-client';
import { BUSINESS_CATEGORIES, type StoreSettings } from '@storeplix/types';
import { Button, Chip, EmptyState, ImageUpload, Input, Select, Spinner, Toggle } from '@storeplix/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plug, Settings as SettingsIcon } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm, type FieldPath } from 'react-hook-form';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { api } from '../lib/api';
import { can } from '../lib/permissions';
import { FormAlert } from '../onboarding/AuthShell';
import { PreviewStoreButton } from '../stores/PreviewStoreButton';
import { storeDomain, storeKey, useTenantStore } from '../stores/useTenantStore';
import { CURRENCIES, DIVISIONS, sectionLabel, settingsKey, settingsSchema, timezones, toFormValues, toPatch, type SettingsValues } from './schema';
import { SettingsCard } from './SettingsLayout';
import facebookIcon from './assets/facebook.svg';
import instagramIcon from './assets/instagram.svg';
import youtubeIcon from './assets/youtube.svg';
import { useBrandUpload } from './useBrandUpload';


export function StoreDetailsPage() {
  const store = useTenantStore().data;
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const settings = useQuery({ queryKey: settingsKey(store?.id), queryFn: () => api.stores.getSettings(store!.id), enabled: !!store, retry: false });

  if (!store || settings.isPending) {
    return (
      <div className="flex justify-center py-16">
        <Spinner label="Loading settings" />
      </div>
    );
  }
  if (settings.isError) return <EmptyState icon={<SettingsIcon />} title="Couldn’t load settings" description={settings.error.message} />;
  // Remount on every server version so the form resets to saved values without effects.
  return <StoreDetailsForm key={settings.data.updated_at} settings={settings.data} storeId={store.id} justSaved={savedAt === settings.data.updated_at} onSaved={setSavedAt} />;
}

// Figma Settings → Store details 60:13854: Shop identity 61:12261 (logo/favicon upload instead of the
// Figma "Manage logos in Online store" link, per contract), Contact 61:12311, Social links 73:22338,
// Business address 61:12343 (+ toggle 61:12381), Language & region 61:12427. Trade licence is Phase 7.
function StoreDetailsForm({ settings, storeId, justSaved, onSaved }: { settings: StoreSettings; storeId: string; justSaved: boolean; onSaved: (updatedAt: string) => void }) {
  const { activeTenant, tenantId } = useAuth();
  const queryClient = useQueryClient();
  const editable = can.editSettings(activeTenant);
  const [formError, setFormError] = useState<string | null>(null);
  const [previews, setPreviews] = useState({ logo: settings.branding.logo?.url ?? null, favicon: settings.branding.favicon?.url ?? null });
  const logo = useBrandUpload('logo');
  const favicon = useBrandUpload('favicon');
  const store = useTenantStore().data;
  const currencyLocked = settings.region.currency_locked === true;

  const {
    register,
    control,
    handleSubmit,
    reset,
    setValue,
    setError,
    formState: { errors, isDirty, dirtyFields, isSubmitting },
  } = useForm<SettingsValues>({ resolver: zodResolver(settingsSchema), defaultValues: toFormValues(settings) });

  const save = useMutation({
    mutationFn: (values: SettingsValues) => api.stores.updateSettings(storeId, toPatch(values, dirtyFields)),
    onSuccess: async (updated) => {
      onSaved(updated.updated_at);
      queryClient.setQueryData(settingsKey(storeId), updated);
      await queryClient.invalidateQueries({ queryKey: storeKey(tenantId) });
    },
    onError: (e) => {
      if (isApiError(e) && e.code === 'currency_locked') {
        setError('region.currency', { message: e.message || 'Your shop’s currency can’t be changed after the first order or expense.' });
        return setFormError('Some fields need attention.');
      }
      if (isApiError(e) && e.isValidation && e.details) {
        let mapped = false;
        for (const [path, messages] of Object.entries(e.details)) {
          if (path.includes('.')) {
            setError(path as FieldPath<SettingsValues>, { message: messages[0] });
            mapped = true;
          }
        }
        if (mapped) return setFormError('Some fields need attention.');
      }
      setFormError(isApiError(e) ? e.message : 'Could not save your changes.');
    },
  });

  const onSubmit = handleSubmit((values) => {
    setFormError(null);
    save.mutate(values);
  });

  const onUpload = (kind: 'logo' | 'favicon') => async (file: File) => {
    const result = await (kind === 'logo' ? logo : favicon).upload(file);
    if (result) {
      setValue(`branding.${kind}_media_id`, result.id, { shouldDirty: true });
      setPreviews((p) => ({ ...p, [kind]: result.url }));
    }
  };
  const onRemove = (kind: 'logo' | 'favicon') => () => {
    setValue(`branding.${kind}_media_id`, null, { shouldDirty: true });
    setPreviews((p) => ({ ...p, [kind]: null }));
  };

  const changed = (Object.keys(dirtyFields) as (keyof SettingsValues)[]).map((k) => sectionLabel[k]);
  const zones = timezones();

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-heading text-text-primary">Store details</h2>
          <p className="text-body text-text-secondary">How your shop appears to customers on the storefront, invoices, SMS and courier labels.</p>
        </div>
        {store && <PreviewStoreButton store={store} />}
      </div>
      {!editable && <FormAlert>Only the owner and managers can change store settings. You can view them here.</FormAlert>}
      {formError && <FormAlert>{formError}</FormAlert>}
      {justSaved && !isDirty && (
        <p role="status" className="rounded-md bg-success-bg px-3 py-2 text-body text-success">
          Changes saved. Your storefront updates within a few seconds.
        </p>
      )}

      <fieldset disabled={!editable} className="flex min-w-0 flex-col gap-6">
        <SettingsCard
          title="Shop identity"
          description={
            <>
              Your shop name shows on invoices, courier labels and every SMS. Add the Bangla name for <span className="font-bangla">বাংলা</span> receipts.
            </>
          }
        >
          <div className="grid gap-5 md:grid-cols-2">
            <ImageUpload
              label="Shop logo"
              src={previews.logo}
              accept={logo.rule.accept}
              hint={logo.rule.hint}
              error={logo.error}
              progress={logo.progress}
              processing={logo.processing}
              disabled={!editable}
              onSelect={onUpload('logo')}
              onRemove={onRemove('logo')}
            />
            <ImageUpload
              label="Favicon"
              src={previews.favicon}
              accept={favicon.rule.accept}
              hint={favicon.rule.hint}
              error={favicon.error}
              progress={favicon.progress}
              processing={favicon.processing}
              disabled={!editable}
              previewSize={48}
              shape="square"
              onSelect={onUpload('favicon')}
              onRemove={onRemove('favicon')}
            />
          </div>
          <hr className="border-border-default" />
          <div className="grid gap-4 md:grid-cols-2">
            <Input label="Shop name (English)" error={errors.identity?.name?.message} {...register('identity.name')} />
            <Input
              label="Shop name (বাংলা)"
              lang="bn"
              className="font-bangla"
              placeholder="মুগ্ধ ফ্যাশন"
              error={errors.identity?.name_bn?.message}
              {...register('identity.name_bn')}
            />
            <Input label="Shop address (URL)" value={settings.identity.primary_domain ?? `${settings.identity.slug}.storeplix.com`} readOnly disabled hint="Connect your own domain in Online store → Domains." />
            <div className="grid grid-cols-2 gap-4">
              <Input label="Brand colour" type="color" className="h-8 cursor-pointer" error={errors.branding?.primary_color?.message} {...register('branding.primary_color')} />
              <Input label="Accent colour" type="color" className="h-8 cursor-pointer" error={errors.branding?.secondary_color?.message} {...register('branding.secondary_color')} />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-body font-medium text-text-primary">Business category</span>
            <Controller
              control={control}
              name="identity.business_categories"
              render={({ field }) => (
                <div role="group" aria-label="Business category" className="flex flex-wrap gap-2">
                  {BUSINESS_CATEGORIES.map(({ code, label }) => {
                    const on = field.value.includes(code);
                    return (
                      <Chip key={code} selected={on} disabled={!editable} onClick={() => field.onChange(on ? field.value.filter((c) => c !== code) : [...field.value, code])}>
                        {label}
                      </Chip>
                    );
                  })}
                </div>
              )}
            />
          </div>
          <p className="flex items-center gap-2 text-caption text-text-secondary">
            <Plug aria-hidden className="size-4" /> Want your own domain like {store ? storeDomain(store).split('.')[0] : 'yourshop'}.com?{' '}
            <Link to="/online-store/domains" className="font-medium text-brand-600 hover:underline">
              Connect a domain
            </Link>
          </p>
        </SettingsCard>

        <SettingsCard title="Contact" description="Customers see this on the storefront and in order SMS. Couriers call this number for pickups.">
          <div className="grid gap-4 md:grid-cols-2">
            <Input label="Phone" type="tel" placeholder="01712-345678" error={errors.contact?.phone?.message} {...register('contact.phone')} />
            <Input label="Email" type="email" placeholder="hello@yourshop.com" error={errors.contact?.email?.message} {...register('contact.email')} />
            <Input label="WhatsApp" type="tel" placeholder="01712-345678" error={errors.contact?.whatsapp?.message} {...register('contact.whatsapp')} />
            <Input label="Support hours" placeholder="10 AM – 10 PM, every day" error={errors.contact?.support_hours?.message} {...register('contact.support_hours')} />
          </div>
        </SettingsCard>

        <SettingsCard title="Social links" description="Shown in your store footer and on order confirmation pages." className="gap-4">
          <SocialRow icon={facebookIcon}>
            <Input label="Facebook page" type="url" placeholder="https://facebook.com/yourpage" error={errors.social?.facebook?.message} {...register('social.facebook')} />
          </SocialRow>
          <SocialRow icon={instagramIcon}>
            <Input label="Instagram" type="url" placeholder="https://instagram.com/yourshop" error={errors.social?.instagram?.message} {...register('social.instagram')} />
          </SocialRow>
          <SocialRow icon={youtubeIcon}>
            <Input label="YouTube" type="url" placeholder="https://youtube.com/@yourshop" error={errors.social?.youtube?.message} {...register('social.youtube')} />
          </SocialRow>
        </SettingsCard>

        <SettingsCard title="Business address" description="Used on invoices and as your default return address.">
          <Input label="Street address" placeholder="House 12, Road 7, Block C, Mirpur 10" error={errors.address?.street?.message} {...register('address.street')} />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Select label="Division" error={errors.address?.division?.message} {...register('address.division')}>
              <option value="">Select</option>
              {DIVISIONS.map((d) => (
                <option key={d}>{d}</option>
              ))}
            </Select>
            <Input label="District" error={errors.address?.district?.message} {...register('address.district')} />
            <Input label="Area / Thana" error={errors.address?.area?.message} {...register('address.area')} />
            <Input label="Postcode" inputMode="numeric" error={errors.address?.postcode?.message} {...register('address.postcode')} />
          </div>
          <hr className="border-border-default" />
          <div className="flex items-center gap-4">
            <div className="flex flex-1 flex-col gap-0.5">
              <span className="text-body font-medium text-text-primary">Use this address for returns</span>
              <span className="text-body text-text-secondary">Couriers send returned parcels here. Turn off to set a return address per courier later.</span>
            </div>
            <Controller
              control={control}
              name="address.use_for_returns"
              render={({ field }) => <Toggle checked={field.value} onChange={field.onChange} disabled={!editable} label="Use this address for returns" />}
            />
          </div>
        </SettingsCard>

        <SettingsCard title="Language & region" description="Choose the language you work in and the one your customers see.">
          <div className="grid gap-6 md:grid-cols-2">
            {[
              ['Admin language', ['English', 'বাংলা']],
              ['Storefront & SMS language', ['বাংলা', 'English', 'Both']],
            ].map(([label, options]) => (
              <div key={label as string} className="flex flex-col gap-2">
                <span className="text-body font-medium text-text-primary">
                  {label} <span className="text-caption font-normal text-text-muted">· coming soon</span>
                </span>
                <div className="flex flex-wrap gap-2">
                  {(options as string[]).map((o, i) => (
                    <Chip key={o} selected={i === 0} disabled>
                      {o}
                    </Chip>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {/* PHASE-8-7 §6.4 (P87-18): the currency locks once the store has an order or an expense. */}
            <Select
              label="Currency"
              error={errors.region?.currency?.message}
              disabled={currencyLocked}
              hint={currencyLocked ? 'Locked after your first order or expense.' : undefined}
              {...register('region.currency')}
            >
              {CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </Select>
            <Select label="Timezone" error={errors.region?.timezone?.message} {...register('region.timezone')}>
              {zones.map((z) => (
                <option key={z}>{z}</option>
              ))}
            </Select>
            <Select label="Number format" disabled hint="Coming soon">
              <option>৳ 1,25,000 (lakh)</option>
            </Select>
          </div>
        </SettingsCard>
      </fieldset>

      {editable && isDirty && (
        <div className="sticky bottom-24 z-10 flex flex-wrap items-center gap-3 rounded-lg bg-text-primary py-3 pr-4 pl-5 shadow-elevation-1 lg:bottom-6">
          <span aria-hidden className="size-2 rounded-full bg-accent-500" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-body font-semibold text-text-inverse">Unsaved changes</span>
            <span className="truncate text-caption text-text-muted">{changed.join(', ')} edited</span>
          </span>
          <Button
            variant="ghost"
            className="text-text-inverse hover:bg-white/10"
            onClick={() => {
              reset(toFormValues(settings));
              setPreviews({ logo: settings.branding.logo?.url ?? null, favicon: settings.branding.favicon?.url ?? null });
            }}
          >
            Discard
          </Button>
          <Button type="submit" loading={isSubmitting || save.isPending}>
            Save changes
          </Button>
        </div>
      )}
    </form>
  );
}

// Figma Social links 73:22338: 44 px surface-subtle tile (radius 12) with the 20 px brand mark, bottom-aligned with the field.
function SocialRow({ icon, children }: { icon: string; children: React.ReactNode }) {
  return (
    <div className="flex items-end gap-3">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-surface-subtle">
        <img src={icon} alt="" width={20} height={20} className="size-5" />
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
