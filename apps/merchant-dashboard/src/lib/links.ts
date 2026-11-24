// Phase 8.1: links out of the merchant dashboard (contract §7.2, §11).

/** Store Plix admin app (impersonation ended / expired link). `VITE_ADMIN_APP_URL`, default the local super-admin. */
export const ADMIN_APP_URL = import.meta.env.VITE_ADMIN_APP_URL || 'http://localhost:5184';

/** "Contact Store Plix support" on the suspended screen. `VITE_SUPPORT_URL` (mailto: or https:). */
export const SUPPORT_URL = import.meta.env.VITE_SUPPORT_URL || 'mailto:support@storeplix.com';

/**
 * PHASE-8-4 Q134: public API reference for the Developer page ("API docs" button, "API reference" row). Both are
 * hidden when `VITE_DEVELOPER_DOCS_URL` is unset (never a fake link).
 */
export const DEVELOPER_DOCS_URL: string | null = import.meta.env.VITE_DEVELOPER_DOCS_URL || null;
