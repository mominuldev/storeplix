import { z } from 'zod';

export const loginSchema = z.object({
  email: z.email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
});
export type LoginValues = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z.object({ email: z.email('Enter a valid email address') });
export type ForgotPasswordValues = z.infer<typeof forgotPasswordSchema>;

// Bangladesh mobile: 01XXXXXXXXX (11 digits); "+88" prefix is shown in the field.
export const bdMobile = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, '').replace(/^\+?88/, ''))
  .pipe(z.string().regex(/^01[3-9]\d{8}$/, 'Enter an 11-digit mobile number, e.g. 01712345678'));

export const registerSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter your full name'),
    email: z.email('Enter a valid email address'),
    phone: bdMobile,
    password: z.string().min(8, 'Use at least 8 characters'),
    password_confirmation: z.string(),
  })
  .refine((v) => v.password === v.password_confirmation, {
    path: ['password_confirmation'],
    message: 'Passwords do not match',
  });
export type RegisterValues = z.infer<typeof registerSchema>;
export type RegisterFormInput = z.input<typeof registerSchema>;

export const businessCategories = ['Fashion', 'Beauty', 'Kids', 'Food & grocery', 'Electronics', 'Home'] as const;

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export const nameShopSchema = z.object({
  name: z.string().trim().min(2, 'Enter your shop name').max(80, 'Keep it under 80 characters'),
  slug: z
    .string()
    .trim()
    .min(3, 'Use at least 3 characters')
    .max(40, 'Use at most 40 characters')
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and dashes'),
  categories: z.array(z.enum(businessCategories)),
});
export type NameShopValues = z.infer<typeof nameShopSchema>;
