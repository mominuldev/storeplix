// Request/response shapes not (yet) in @storeplix/types. Proposed for promotion to packages/types.
import type { User } from '@storeplix/types';

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

export type TenantRole = 'owner' | 'admin' | 'staff' | (string & {});

export interface TenantMembership {
  id: string;
  name: string;
  slug?: string;
  role: TenantRole;
}

/** `GET /auth/me`. `tenants` is optional until the contract adds it. */
export type MeResponse = User & { tenants?: TenantMembership[] };

export interface CreateStoreInput {
  name: string;
  slug: string;
  country: string;
  currency: string;
  business_category?: string | null;
}
