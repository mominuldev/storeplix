// Input/response types live in @storeplix/types (Phase 2 §3). Only client-local aliases remain here.
import type { User } from '@storeplix/types';

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
