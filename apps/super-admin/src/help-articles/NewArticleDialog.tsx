import { zodResolver } from '@hookform/resolvers/zod';
import { isApiError } from '@storeplix/api-client';
import { HELP_LIMITS, HELP_SLUG_PATTERN } from '@storeplix/types';
import { Dialog, Input, Select } from '@storeplix/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { slugify } from './doc';
import { helpKeys, useHelpCategories } from './queries';

const schema = z.object({
  title_en: z.string().trim().min(1, 'Enter an English title').max(HELP_LIMITS.title, `Keep the title under ${HELP_LIMITS.title} characters`),
  slug: z
    .string()
    .trim()
    .min(1, 'Enter a slug')
    .max(HELP_LIMITS.slug, `Keep the slug under ${HELP_LIMITS.slug} characters`)
    .regex(HELP_SLUG_PATTERN, 'Use lowercase letters, numbers and single dashes'),
  category_id: z.string().min(1, 'Pick a category'),
});
type Values = z.infer<typeof schema>;

// New article dialog (PHASE-8-9C §14, `/help-articles/new`): English title, slug (auto-kebab until edited), category →
// creates a draft and opens the editor.
export function NewArticleDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const formId = useId();
  const queryClient = useQueryClient();
  const categories = useHelpCategories();
  const { register, handleSubmit, formState, setValue, setError, getFieldState } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { title_en: '', slug: '', category_id: '' },
  });
  const create = useMutation({
    mutationFn: (v: Values) => api.admin.help.articles.create({ title_en: v.title_en.trim(), slug: v.slug.trim(), category_id: v.category_id }),
    onSuccess: (a) => {
      void queryClient.invalidateQueries({ queryKey: helpKeys.articles });
      queryClient.setQueryData(helpKeys.article(a.id), a);
      onCreated(a.id);
    },
    onError: (e) => {
      if (isApiError(e) && e.code === 'help_slug_taken') setError('slug', { message: errorMessage(e) });
    },
  });
  const title = register('title_en');
  const noCategories = categories.isSuccess && categories.data.length === 0;

  return (
    <Dialog
      open
      title="New article"
      description="Start with the English title. You can add বাংলা in the editor."
      confirmLabel="Create draft"
      formId={formId}
      loading={create.isPending}
      confirmDisabled={noCategories}
      onConfirm={() => undefined}
      onCancel={onClose}
    >
      <form id={formId} noValidate className="flex flex-col gap-4" onSubmit={handleSubmit((v) => create.mutate(v))}>
        <Input
          label="Title (English)"
          placeholder="How to book a parcel with Steadfast"
          error={formState.errors.title_en?.message}
          {...title}
          onChange={(e) => {
            void title.onChange(e);
            if (!getFieldState('slug').isDirty) setValue('slug', slugify(e.target.value));
          }}
        />
        <Input
          label="Slug"
          leading={<span className="text-body text-text-muted">/help/articles/</span>}
          error={formState.errors.slug?.message}
          {...register('slug')}
        />
        <Select label="Category" error={formState.errors.category_id?.message ?? (noCategories ? 'Add a category first (Categories button).' : undefined)} {...register('category_id')}>
          <option value="">Choose a category</option>
          {(categories.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name_en}
            </option>
          ))}
        </Select>
        {create.isError && !(isApiError(create.error) && create.error.code === 'help_slug_taken') && (
          <p role="alert" className="text-body text-danger">
            {errorMessage(create.error)}
          </p>
        )}
      </form>
    </Dialog>
  );
}
