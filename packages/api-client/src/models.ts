// Input/response types live in @storeplix/types (Phase 2 §3). Only client-local aliases remain here.
import type { CourierAccount, CourierArea, User } from '@storeplix/types';

export type {
  AcceptInvitationInput,
  ChangePasswordInput,
  CreateStoreInput,
  ForgotPasswordInput,
  InviteStaffInput,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
  TenantMembership,
  TenantRole,
  UpdateProfileInput,
  UpdateStaffRoleInput,
  UpdateStoreSettingsInput,
} from '@storeplix/types';

/** `GET /auth/me` returns `User` (with `tenants` and `password_changed_at`). */
export type MeResponse = User;

// Phase 5b §4.6 couriers: response shapes that openapi 1.6.0 declares inline (no named schema in @storeplix/types).
/** `PUT /couriers/{provider}`: the account plus the webhook secret, returned once (Steadfast/Pathao; RedX null). */
export interface CourierConnectResult { account: CourierAccount; webhook_secret: string | null }
/** `POST /couriers/{provider}/test`. `balance_amount` in paisa when the courier reports one (Steadfast). */
export interface CourierTestResult { ok: boolean; checked_at: string; balance_amount?: number | null }
/** `POST /couriers/{provider}/webhook-secret`: the new secret, shown once; the old one stops working at once. */
export interface CourierWebhookSecret { webhook_url: string; webhook_secret: string }
/** `GET /couriers/{provider}/pickup-stores` (Pathao stores, RedX pickup stores). */
export interface CourierPickupStore { id: string; name: string; address: string | null }
/** `GET /couriers/{provider}/areas`: one level; `suggested` when `district_code`/`thana_code` were sent. */
export interface CourierAreaList {
  data: CourierArea[];
  suggested: { city_id: string | null; zone_id: string | null; area_id: string | null } | null;
}
export interface CourierAreaQuery { level: 'city' | 'zone' | 'area'; parent_id?: string; district_code?: string; thana_code?: string }
