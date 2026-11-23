// Phase 8.1: links out of the merchant dashboard (contract §7.2, §11).

/** Store Plix admin app (impersonation ended / expired link). `VITE_ADMIN_APP_URL`, default the local super-admin. */
export const ADMIN_APP_URL = import.meta.env.VITE_ADMIN_APP_URL || 'http://localhost:5174';

/** "Contact Store Plix support" on the suspended screen. `VITE_SUPPORT_URL` (mailto: or https:). */
export const SUPPORT_URL = import.meta.env.VITE_SUPPORT_URL || 'mailto:support@storeplix.com';
