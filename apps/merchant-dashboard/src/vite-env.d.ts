/// <reference types="vite/client" />
interface ImportMetaEnv {
  /** Unset = same-origin (Phase 4.7). */
  readonly VITE_API_URL?: string;
  /** Dev server only: where the Vite proxy sends /api and /sanctum. */
  readonly VITE_API_PROXY_TARGET?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
