import { z } from 'zod';

export const loginSchema = z.object({
  email: z.email('Enter a valid work email'),
  password: z.string().min(1, 'Enter your password'),
  remember: z.boolean().optional(),
});
export type LoginValues = z.infer<typeof loginSchema>;

