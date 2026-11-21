// Request shapes not (yet) in @storeplix/types. Proposed for promotion to packages/types.
import type { User } from '@storeplix/types';

export type { TenantMembership, TenantRole } from '@storeplix/types';

export interface RegisterInput {
  name: string;
  email: string;
  password: string;
  password_confirmation: string;
  phone?: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface ForgotPasswordInput {
  email: string;
}

/** `GET /auth/me` returns `User` (with `tenants`). */
export type MeResponse = User;

export interface CreateStoreInput {
  name: string;
  slug: string;
  country: string;
  currency: string;
  business_category?: string | null;
}
