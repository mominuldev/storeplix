import { describe, expect, it } from 'vitest';
import { loginSchema, registerSchema } from './schemas';

const valid = { name: 'Rahim Ahmed', email: 'rahim@shop.com', phone: '01712345678', password: 'secret123', password_confirmation: 'secret123' };

describe('auth schemas', () => {
  it('rejects an invalid email and empty password on login', () => {
    const result = loginSchema.safeParse({ email: 'nope', password: '' });
    expect(result.success).toBe(false);
    const fields = result.error!.issues.map((i) => i.path[0]);
    expect(fields).toEqual(expect.arrayContaining(['email', 'password']));
  });

  it('accepts a valid registration', () => {
    expect(registerSchema.safeParse(valid).success).toBe(true);
  });

  it('requires matching passwords of at least 8 characters', () => {
    const mismatch = registerSchema.safeParse({ ...valid, password_confirmation: 'other123' });
    expect(mismatch.error?.issues[0]).toMatchObject({ path: ['password_confirmation'], message: 'Passwords do not match' });
    const short = registerSchema.safeParse({ ...valid, password: 'short', password_confirmation: 'short' });
    expect(short.error?.issues.some((i) => i.path[0] === 'password')).toBe(true);
  });

  it('validates phone format when provided', () => {
    expect(registerSchema.safeParse({ ...valid, phone: 'abc' }).success).toBe(false);
    expect(registerSchema.safeParse({ ...valid, phone: '+8801712-345678' }).data?.phone).toBe('01712345678');
  });
});
