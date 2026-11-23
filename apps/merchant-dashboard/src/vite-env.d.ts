/// <reference types="vite/client" />
interface ImportMetaEnv {
  /** Unset = same-origin (Phase 4.7). */
  readonly VITE_API_URL?: string;
  /** Dev server only: where the Vite proxy sends /api and /sanctum. */
  readonly VITE_API_PROXY_TARGET?: string;
  /** Phase 8.1: Store Plix admin app (impersonation ended screen). Default http://localhost:5174. */
  readonly VITE_ADMIN_APP_URL?: string;
  /** Phase 8.1: "Contact Store Plix support" link on the suspended screen. */
  readonly VITE_SUPPORT_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
