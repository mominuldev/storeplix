// API contract shared by all TS apps. Mirrors Laravel API Resources in apps/api.
// Change here => change the Laravel resource in the same PR (see docs/api/API-CONVENTIONS.md).

export interface ApiSuccess<T> { data: T; meta?: PaginationMeta | Record<string, unknown> }
export interface ApiError { error: { code: string; message: string; details?: Record<string, string[]> } }
export interface PaginationMeta { current_page: number; per_page: number; total: number; last_page: number }

export interface HealthStatus { status: 'ok'; version: string; time: string }

export type TenantRole = 'owner' | 'admin' | 'staff';
export interface TenantMembership { id: string; name: string; role: TenantRole }
export interface User {
  id: string; name: string; email: string; phone: string | null; created_at: string;
  /** Present on /auth/me and auth token responses. */
  tenants?: TenantMembership[];
}
export interface AuthToken { token: string; user: User }

export type StoreStatus = 'draft' | 'active' | 'suspended';
export interface Store {
  id: string; tenant_id: string; name: string; slug: string; status: StoreStatus;
  country: string; currency: string; business_category: string | null;
  primary_domain: string | null; created_at: string;
}

export type DomainStatus =
  | 'pending_verification' | 'verification_failed' | 'verified'
  | 'ssl_provisioning' | 'active' | 'expired' | 'suspended';

export interface ThemeSection { type: string; enabled: boolean; settings?: Record<string, unknown> }
export interface ThemeConfig {
  theme: string; version: string;
  settings: { primaryColor: string; secondaryColor: string; fontFamily: string; [k: string]: unknown };
  sections: ThemeSection[];
}

/** Public, render-only payload for GET /api/v1/storefront/config. No internal ids beyond store id. */
export interface StorefrontConfig {
  store: { id: string; name: string; slug: string; currency: string; logo_url: string | null; favicon_url: string | null };
  theme: ThemeConfig;
  seo: { title: string; description: string | null };
}
