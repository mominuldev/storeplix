import { z } from 'zod';

export const loginSchema = z.object({
  email: z.email('Enter a valid work email'),
  password: z.string().min(1, 'Enter your password'),
});
export type LoginValues = z.infer<typeof loginSchema>;

export const recoveryCodeSchema = z.object({
  recovery_code: z
    .string()
    .trim()
    .transform((v) => v.replace(/[\s-]/g, ''))
    .pipe(z.string().length(10, 'Recovery codes have 10 characters')),
});

export const acceptNewSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter your full name').max(120),
    password: z.string().min(8, 'Use at least 8 characters').max(128, 'Use at most 128 characters'),
    password_confirmation: z.string(),
  })
  .refine((v) => v.password === v.password_confirmation, {
    path: ['password_confirmation'],
    message: 'Passwords don’t match',
  });
export type AcceptNewValues = z.infer<typeof acceptNewSchema>;

export const acceptExistingSchema = z.object({
  password: z.string().min(1, 'Enter your current password'),
});
export type AcceptExistingValues = z.infer<typeof acceptExistingSchema>;
