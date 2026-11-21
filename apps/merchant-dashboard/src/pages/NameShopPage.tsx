import { zodResolver } from '@hookform/resolvers/zod';
import { isApiError } from '@storeplix/api-client';
import { Button, Card, Chip, Input, ProgressBar } from '@storeplix/ui';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronLeft } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { applyApiErrors } from '../auth/formErrors';
import { businessCategories, nameShopSchema, slugify, type NameShopValues } from '../auth/schemas';
import { api } from '../lib/api';
import { FormAlert } from '../onboarding/AuthShell';
import { PhonePreview } from '../onboarding/PhonePreview';
import { StepRail } from '../onboarding/StepRail';
import { fetchTenantStore, storeKey } from '../stores/useTenantStore';

// Figma Merchant Onboarding · 03 Name your shop 48:7869 (desktop: rail · form · live preview) / M3 53:885.
// Sends POST /stores. Phase 1 contract has no Bangla name or sales-channel fields, so those Figma
// inputs are not shown. Country/currency default to Bangladesh/BDT. 409 store_limit_reached → dashboard.
export function NameShopPage() {
  const { tenantId, logout } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);
  const [slugTouched, setSlugTouched] = useState(false);
  const {
    register,
    control,
    handleSubmit,
    setValue,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<NameShopValues>({ resolver: zodResolver(nameShopSchema), defaultValues: { name: '', slug: '', categories: [] } });

  const name = useWatch({ control, name: 'name' });
  const slug = useWatch({ control, name: 'slug' });
  const domain = `${slug || 'yourshop'}.storeplix.com`;

  const nameField = register('name', {
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!slugTouched) setValue('slug', slugify(e.target.value), { shouldValidate: !!errors.slug });
    },
  });

  const onSubmit = handleSubmit(async ({ name: shopName, slug: shopSlug, categories }) => {
    setFormError(null);
    try {
      const store = await api.stores.create({
        name: shopName,
        slug: shopSlug,
        country: 'BD',
        currency: 'BDT',
        business_category: categories.length ? categories.join(', ') : null,
      });
      queryClient.setQueryData(storeKey(tenantId), store);
      navigate('/', { replace: true });
    } catch (error) {
      if (isApiError(error) && error.status === 409 && error.code === 'store_limit_reached') {
        // One store per tenant (D1): it already exists — open it.
        await queryClient.fetchQuery({ queryKey: storeKey(tenantId), queryFn: () => fetchTenantStore(tenantId ?? undefined), staleTime: 0 });
        navigate('/', { replace: true });
        return;
      }
      setFormError(applyApiErrors(error, setError, ['name', 'slug']));
    }
  });

  return (
    <div className="flex min-h-dvh bg-surface-canvas">
      <StepRail shopName={name} />
      <div className="flex min-w-0 flex-1 flex-col lg:items-center">
        {/* Desktop top bar */}
        <div className="hidden w-full items-center justify-between px-10 py-5 lg:flex">
          <span className="text-caption font-medium text-text-secondary">Step 3 of 7</span>
          <Button variant="ghost" size="sm" onClick={() => void logout()}>
            Sign out
          </Button>
        </div>
        {/* Mobile app bar (M3) */}
        <header className="flex flex-col gap-3 px-4 pt-2 pb-3 lg:hidden">
          <div className="flex items-center justify-between">
            <button
              type="button"
              aria-label="Sign out"
              onClick={() => void logout()}
              className="flex size-9 items-center justify-center rounded-full border border-border-default bg-surface-card"
            >
              <ChevronLeft aria-hidden className="size-[18px]" />
            </button>
            <span className="text-body font-semibold text-text-primary">Step 3 of 7</span>
            <span className="size-9" />
          </div>
          <ProgressBar value={3 / 7} label="Setup progress" className="h-1 rounded-[2px]" />
        </header>

        <form onSubmit={onSubmit} noValidate className="flex w-full max-w-[620px] flex-1 flex-col gap-5 px-5 pt-3 pb-28 lg:gap-7 lg:px-0 lg:pt-2 lg:pb-12">
          <div className="flex flex-col gap-1.5 lg:gap-2">
            <h1 className="text-heading-24 text-text-primary lg:text-heading-32">Name your shop</h1>
            <p className="text-body text-text-secondary lg:text-body-lg">
              This is what customers see on your page, receipts and SMS. You can change it any time.
            </p>
            <p lang="bn" className="hidden font-bangla text-body-lg leading-[26px] text-text-muted lg:block">
              আপনার দোকানের নাম বাংলা বা ইংরেজিতে লিখুন
            </p>
          </div>
          {formError && <FormAlert>{formError}</FormAlert>}

          <Card className="flex flex-col gap-5 border-0 bg-transparent p-0 shadow-none lg:border lg:bg-surface-card lg:p-6 lg:shadow-elevation-1">
            <h2 className="hidden text-body-lg font-medium text-text-primary lg:block">Shop details</h2>
            <Input label="Shop name" placeholder="Mugdho Fashion" autoComplete="organization" error={errors.name?.message} {...nameField} />
            <Input
              label="Your shop link"
              fieldClassName="min-h-12 lg:min-h-11"
              className="text-body-lg font-medium"
              leading={<span className="hidden font-normal text-text-muted lg:inline">https://</span>}
              trailing={<span className="text-body-lg text-text-muted">.storeplix.com</span>}
              hint="You can connect your own domain later."
              error={errors.slug?.message}
              {...register('slug', {
                onChange: () => setSlugTouched(true),
                setValueAs: (v: string) => v.toLowerCase(),
              })}
            />
          </Card>

          <Card className="flex flex-col gap-2.5 border-0 bg-transparent p-0 shadow-none lg:gap-5 lg:border lg:bg-surface-card lg:p-6 lg:shadow-elevation-1">
            <div className="flex flex-col gap-1">
              <h2 className="text-body-lg font-medium text-text-primary">What do you sell?</h2>
              <p className="hidden text-body text-text-secondary lg:block">Pick one or more — we’ll set up categories and size charts for you.</p>
            </div>
            <Controller
              control={control}
              name="categories"
              render={({ field }) => (
                <div className="flex flex-wrap gap-2" role="group" aria-label="What do you sell?">
                  {businessCategories.map((c) => {
                    const selected = field.value.includes(c);
                    return (
                      <Chip
                        key={c}
                        selected={selected}
                        onClick={() => field.onChange(selected ? field.value.filter((v) => v !== c) : [...field.value, c])}
                      >
                        {c}
                      </Chip>
                    );
                  })}
                </div>
              )}
            />
          </Card>

          {/* M3 mini preview */}
          <div className="flex items-center gap-3 rounded-[14px] bg-brand-50 p-3.5 lg:hidden">
            <span className="flex size-10 items-center justify-center rounded-full bg-brand-600 text-body font-semibold text-text-inverse">
              {name.trim().charAt(0).toUpperCase() || 'S'}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-body font-semibold text-text-primary">{name || 'Your shop'}</span>
              <span className="truncate text-caption text-brand-700">{domain}</span>
            </span>
          </div>

          <div className="fixed inset-x-0 bottom-0 border-t border-border-default bg-surface-card px-5 pt-4 pb-[max(16px,env(safe-area-inset-bottom))] lg:static lg:flex lg:justify-end lg:border-0 lg:bg-transparent lg:p-0">
            <Button type="submit" loading={isSubmitting} className="w-full lg:w-auto">
              Continue
            </Button>
          </div>
        </form>
      </div>
      <PhonePreview name={name} domain={domain} />
    </div>
  );
}
