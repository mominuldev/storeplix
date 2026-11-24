// API contract shared by all TS apps. Mirrors Laravel API Resources in apps/api.
// Change here => change the Laravel resource in the same PR (see docs/api/API-CONVENTIONS.md).

export interface ApiSuccess<T> { data: T; meta?: PaginationMeta | Record<string, unknown> }
export interface ApiError { error: { code: string; message: string; details?: Record<string, string[]>; /** seconds; present on 429 (also sent as Retry-After header) */ retry_after?: number } }
export interface PaginationMeta { current_page: number; per_page: number; total: number; last_page: number }

export interface HealthStatus { status: 'ok'; version: string; time: string }

/** Phase 8.3: 'custom' = a tenant-defined role (PHASE-8-3 §8). */
export type TenantRole = 'owner' | 'admin' | 'staff' | 'custom';
export type SystemRoleKey = 'owner' | 'admin' | 'staff';
export interface TenantMembership {
  id: string; name: string; role: TenantRole;
  role_id: string; role_name: string;
  /** Resolved permission set; the API stays the source of truth (PHASE-8-3 §7.1). */
  permissions: PermissionKey[];
}
export interface User {
  id: string; name: string; email: string; phone: string | null; created_at: string;
  password_changed_at: string | null;
  phone_verified_at: string | null;
  /** Present on /auth/me and auth token responses. */
  tenants?: TenantMembership[];
}

export type StoreStatus = 'draft' | 'active' | 'suspended';
export interface Store {
  id: string; tenant_id: string; name: string; slug: string; status: StoreStatus;
  country: string; currency: string;
  business_categories: BusinessCategory[]; name_bn: string | null; timezone: string;
  primary_domain: string | null; created_at: string;
}

export type DomainStatus =
  | 'pending_verification' | 'verification_failed' | 'verified'
  | 'ssl_provisioning' | 'active' | 'expired' | 'suspended';

// ThemeSection / ThemeConfig: see "Theme engine (Phase 3)" below.

/** Public, render-only payload for GET /api/v1/storefront/config. No internal ids beyond store id. */
export interface StorefrontConfig {
  store: {
    id: string; name: string; slug: string; status: 'active' | 'draft'; currency: string;
    /** logo variant w320 (or original while processing) */
    logo_url: string | null;
    /** favicon_32 variant */
    favicon_url: string | null;
    icons?: { apple_touch: string | null; icon_192: string | null; icon_512: string | null };
    /** canonical host */
    primary_host: string;
    /**
     * Phase 6 (P6-15): the primary host, set only when this request's host is not the primary, the request is not a
     * valid preview, and the primary or this host is a custom domain (platform hosts never redirect to a platform
     * primary). The storefront permanently redirects to it. Optional for rolling deploys.
     */
    redirect_host?: string | null;
  };
  /** Public contact only — never the business address. Optional for rolling deploys. */
  contact?: StoreContact;
  social?: SocialLinks;
  /** true only when a valid X-Storefront-Preview token for this store was sent */
  preview: boolean;
  theme: ThemeConfig;
  seo: { title: string; description: string | null; og_image_url: string | null; noindex: boolean };
  /** Optional on the wire for rolling deploys; storefront defaults to empty. */
  navigation?: { main: StorefrontNavMenu; footer: StorefrontNavMenu; help: StorefrontNavMenu };
  /** Media ids referenced by `theme`. */
  media?: Record<string, StorefrontMedia>;
  /** Phase 5. Optional on the wire for rolling deploys. */
  commerce?: StorefrontCommerce;
}

export interface PreviewToken { token: string; url: string; /** ISO-8601 */ expires_at: string }


// ---------- Inputs (promoted from api-client/models.ts) ----------
export interface RegisterInput { name: string; email: string; password: string; password_confirmation: string; phone: string }
export interface LoginInput { email: string; password: string }
export interface ForgotPasswordInput { email: string }
export interface ResetPasswordInput { email: string; token: string; password: string; password_confirmation: string }
export interface MessageResponse { message: string }

// ---------- Business categories (decision: ARRAY of codes; replaces Store.business_category) ----------
export const BUSINESS_CATEGORIES = [
  { code: 'fashion', label: 'Fashion' },
  { code: 'beauty', label: 'Beauty' },
  { code: 'kids', label: 'Kids' },
  { code: 'food_grocery', label: 'Food & grocery' },
  { code: 'electronics', label: 'Electronics' },
  { code: 'home', label: 'Home' },
] as const;
export type BusinessCategory = (typeof BUSINESS_CATEGORIES)[number]['code'];

export interface CreateStoreInput {
  name: string; slug: string; country?: string; currency?: string;
  business_categories?: BusinessCategory[]; name_bn?: string | null; timezone?: string;
}



// ---------- Account ----------
export interface UpdateProfileInput { name?: string; email?: string; phone?: string | null; current_password?: string }
export interface ChangePasswordInput { current_password: string; password: string; password_confirmation: string }

// ---------- Staff ----------
/** Legacy input only (PHASE-8-3); prefer role_id. */
export type AssignableRole = 'admin' | 'staff';
export interface StaffMember {
  id: string;                       // tenant_users.id (kind=member) or staff_invitations.id (kind=invitation)
  kind: 'member' | 'invitation';
  user_id: string | null;           // null for invitations
  name: string | null;              // invitation name may be null
  email: string;
  phone: string | null;
  role: TenantRole;
  role_id: string;
  role_name: string;
  status: 'active' | 'invited' | 'expired';
  is_you: boolean;
  invited_by: { id: string; name: string } | null;
  joined_at: string | null;
  expires_at: string | null;        // invitations only
  created_at: string;
}
export interface StaffSeatsMeta { seats_used: number; seats_limit: number | null }
export type InviteStaffInput = { email: string; name?: string | null } & (
  { role_id: string; role?: never } | { role: AssignableRole; role_id?: never }
);
export type UpdateStaffRoleInput = { role_id: string; role?: never } | { role: AssignableRole; role_id?: never };
export interface InvitationPreview {
  tenant_name: string; store_name: string | null; email: string; role: Exclude<TenantRole, 'owner'>; role_name: string;
  invited_by_name: string; expires_at: string; user_exists: boolean;
}
export interface AcceptInvitationInput { name: string; password: string; password_confirmation: string; phone: string }

// ---------- Media ----------
export type MediaPurpose = 'logo' | 'favicon' | 'product_image' | 'page_image';
export type MediaStatus = 'processing' | 'ready' | 'failed';
export interface MediaVariant { key: string; width: number; height: number; mime: string; url: string }
export interface Media {
  id: string; purpose: MediaPurpose; status: MediaStatus; mime: string; size_bytes: number;
  width: number; height: number; alt: string | null;
  url: string;                      // original, absolute
  variants: MediaVariant[];         // empty while processing
  created_at: string;
}
/** Compact reference embedded in other resources. `url` = best display variant (or original while processing). */
export interface MediaRef { id: string; url: string; width: number; height: number; status: MediaStatus }

// ---------- Store settings ----------
export interface SocialLinks { facebook: string | null; instagram: string | null; youtube: string | null }
export interface StoreContact { phone: string | null; email: string | null; whatsapp: string | null; support_hours: string | null }
export interface BusinessAddress {
  street: string | null; division: string | null; district: string | null; area: string | null;
  postcode: string | null; use_for_returns: boolean;
}
export interface StoreSettings {
  store_id: string;
  identity: { name: string; name_bn: string | null; slug: string; primary_domain: string | null; business_categories: BusinessCategory[] };
  branding: { logo: MediaRef | null; favicon: MediaRef | null; primary_color: string; secondary_color: string };
  contact: StoreContact;
  social: SocialLinks;
  address: BusinessAddress;
  /**
   * `currency_locked` (PHASE-8-7 P87-18): true once the store has an order or an expense; a PATCH with a different
   * `region.currency` then → 409 `currency_locked`.
   */
  region: { country: string; currency: string; timezone: string; currency_locked: boolean };
  seo: StoreSeo;
  /** Phase 5 */
  commerce: StoreCommerceSettings;
  updated_at: string;
}
export interface UpdateStoreSettingsInput {
  identity?: Partial<{ name: string; name_bn: string | null; business_categories: BusinessCategory[] }>;
  branding?: Partial<{ logo_media_id: string | null; favicon_media_id: string | null; primary_color: string; secondary_color: string }>;
  contact?: Partial<StoreContact>;
  social?: Partial<SocialLinks>;
  address?: Partial<BusinessAddress>;
  region?: Partial<{ country: string; currency: string; timezone: string }>;
  seo?: Partial<{ title: string | null; description: string | null; share_image_media_id: string | null; hide_from_search: boolean }>;
  /** Phase 5 */
  checkout?: { cod_enabled?: boolean; /** 5b */ cod_advance?: 'none' | 'delivery_charge' };
  order_prefix?: string;
  notifications?: { new_order_email?: boolean; sms_language?: 'bn' | 'en'; customer_sms?: Partial<Record<CustomerSmsEvent, boolean>> };
  /** 5b (PHASE-5B-CONTRACT §4 settings additions) */
  tax?: { display?: 'none' | 'included'; rate_bps?: number; bin?: string | null };
  invoice?: { footer?: string | null };
}

// ---------- Plans / subscription / features ----------
export type FeatureKey =
  | 'custom_domain' | 'all_couriers' | 'bulk_courier_booking' | 'fake_order_guard' | 'sms_automation'
  | 'custom_roles' | 'multi_warehouse' | 'pos' | 'profit_reports' | 'api_webhooks'
  /** Phase 8.8b (PHASE-8-8B §2.2): suppliers + purchase orders; Starter + Growth. Without it writes 402, reads 200. */
  | 'purchasing';
export type LimitKey = 'orders_per_month' | 'staff_seats' | 'products' | 'courier_connections' | 'sms_per_month'
  /** Phase 6 (PHASE-6-CONTRACT P6-7): custom store_domains rows, any status */
  | 'custom_domains'
  /**
   * Phase 8.5 (PHASE-8-5 P85-13): campaign SMS **parts** / campaign emails per calendar month (store tz). Free 0.
   * Phase 8.6 (P86-8): shared with automation messages; labels "Marketing SMS" / "Marketing emails".
   */
  | 'campaign_sms_per_month' | 'campaign_emails_per_month';
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'cancelled' | 'expired';

// ---------- Audit ----------
export interface AuditLog {
  id: string; action: string;
  /** Phase 8.1: `platform_user` = Storeplix staff, shown as "Store Plix support" (id null for merchants). */
  actor: { type: AuditActorType; id: string | null; name: string | null } | null;
  subject: { type: string; id: string } | null;
  meta: Record<string, unknown>;
  ip: string | null; user_agent: string | null; created_at: string;
}
export interface AuditLogFilters {
  action?: string; actor_id?: string; subject_id?: string;
  /** Phase 8.1: `platform_user` lists Store Plix support actions only. */
  actor_type?: AuditActorType;
  /** server allowlist; Phase 5 adds 'order' | 'coupon' | 'shipping' | 'store'; 5b 'payment_gateway' | 'courier' | 'shipment' | 'return' */
  subject_type?: string;
  created_from?: string; created_to?: string; page?: number; per_page?: number;
}  // api-client maps these to filter[...] query params

// ---------- Phone OTP (Addendum A) ----------
export type OtpPurpose = 'verify_phone' | 'login' | 'reset_password';
export interface SendOtpInput { phone: string; purpose: OtpPurpose }
/** `dev_otp` is only present in local dev with SMS_DRIVER=log. Never rely on it. */
export interface SendOtpResponse { expires_in: number; resend_in: number; dev_otp?: string }
export interface VerifyPhoneInput { code: string }
export interface OtpLoginInput { phone: string; code: string }
export interface OtpResetPasswordInput { phone: string; code: string; password: string; password_confirmation: string }

// ---------- Theme engine (Phase 3) ----------
export interface ThemeBlock { id: string; type: string; settings: Record<string, unknown> }
export interface ThemeSection {
  id: string; type: string; enabled: boolean;
  settings?: Record<string, unknown>;
  blocks?: ThemeBlock[];
}
export interface ThemeGlobalSettings {
  primaryColor: string; secondaryColor: string; textColor: string; backgroundColor: string;
  fontFamily: string; headingFontFamily: string;
  cornerStyle: 'square' | 'rounded' | 'pill'; buttonStyle: 'solid' | 'outline'; stylePreset: string | null;
  logoOnDarkMediaId: string | null;
  announcement: { enabled: boolean; text: string; href: string | null };
  header: { sticky: boolean; showSearch: boolean; promoLink: { label: string; href: string } | null };
  footer: { tagline: string | null; showPaymentMethods: boolean; paymentMethods: PaymentMethodBadge[] };
  [k: string]: unknown;                     // theme-specific extras (validated by the theme's JSON Schema)
}
export type PaymentMethodBadge = 'cod' | 'bkash' | 'nagad' | 'rocket' | 'upay' | 'visa' | 'mastercard' | 'amex';
export interface ThemeConfig { theme: string; version: string; settings: ThemeGlobalSettings; sections: ThemeSection[] }

export type ThemeAvailability = 'available' | 'coming_soon';
export interface ThemeCatalogEntry {
  code: string; name: string; description: string; version: string;
  status: ThemeAvailability; tier: 'free' | 'premium';
  price_amount: number | null;              // BDT minor units, premium only (display; not purchasable in Phase 3)
  currency: string | null; tags: string[]; is_new: boolean;
}
export interface UserRef { id: string; name: string }
export interface StoreThemeSummary {
  id: string; code: string; name: string; version: string; is_active: boolean;
  draft_revision: number; published_revision: number | null; has_unpublished_changes: boolean;
  draft_updated_at: string; draft_updated_by: UserRef | null;
  published_at: string | null; published_by: UserRef | null; applied_at: string | null;
}
export interface StoreTheme extends StoreThemeSummary {
  draft_config: ThemeConfig;
  published_config: ThemeConfig | null;
  /** Media referenced by draft or published config, for editor thumbnails. */
  media: Record<string, MediaRef>;
}
export interface SaveThemeDraftInput { config: ThemeConfig; base_revision: number }
export interface PublishThemeInput { draft_revision: number }

// ---------- Rich text (strict subset of ProseMirror/Tiptap JSON) ----------
export type RichTextMark =
  | { type: 'bold' | 'italic' | 'underline' | 'strike' }
  | { type: 'link'; attrs: { href: string } };
export interface RichTextText { type: 'text'; text: string; marks?: RichTextMark[] }
export interface RichTextHardBreak { type: 'hardBreak' }
export type RichTextInline = RichTextText | RichTextHardBreak;
export interface RichTextParagraph { type: 'paragraph'; content?: RichTextInline[] }
export interface RichTextHeading { type: 'heading'; attrs: { level: 2 | 3 }; content?: RichTextInline[] }
export interface RichTextListItem { type: 'listItem'; content: RichTextParagraph[] }
export interface RichTextList { type: 'bulletList' | 'orderedList'; content: RichTextListItem[] }
export interface RichTextBlockquote { type: 'blockquote'; content: RichTextParagraph[] }
export type RichTextBlock = RichTextParagraph | RichTextHeading | RichTextList | RichTextBlockquote;
export interface RichTextDoc { type: 'doc'; content: RichTextBlock[] }

// ---------- Pages ----------
export type PageStatus = 'draft' | 'published' | 'hidden';
export type PageTemplateCode =
  | 'blank' | 'about' | 'contact' | 'faq' | 'size_guide' | 'how_to_order' | 'wholesale' | 'privacy' | 'terms' | 'returns';
export type PageBlock =
  | { id: string; type: 'heading'; text: string; level: 2 | 3 }
  | { id: string; type: 'rich_text'; doc: RichTextDoc }
  | { id: string; type: 'image'; media_id: string | null; alt: string | null; caption: string | null }
  | { id: string; type: 'button'; label: string; href: string; style: 'primary' | 'secondary' }
  | { id: string; type: 'callout'; title: string | null; items: string[]; tone: 'info' | 'success' | 'warning' }
  | { id: string; type: 'table'; headers: string[]; rows: string[][] };
export interface PageTemplate {
  code: PageTemplateCode; name: string; description: string;
  category: 'blank' | 'help_policies' | 'about' | 'selling';
  default_title: string; default_slug: string | null; highlights: string[];
}
export interface StorePageSummary {
  id: string; title: string; slug: string; url_path: string;   // "/pages/{slug}"
  status: PageStatus; template: PageTemplateCode;
  in_menus: NavigationHandle[]; revision: number;
  published_at: string | null; updated_at: string; updated_by: UserRef | null;
}
export interface StorePage extends StorePageSummary {
  body: PageBlock[];
  seo: { title: string | null; description: string | null; share_image: MediaRef | null };
  media: Record<string, MediaRef>;          // images referenced by body
}
export interface PageListMeta { counts: Record<'all' | PageStatus, number>; limit: number }
export interface CreatePageInput {
  title?: string; slug?: string; template?: PageTemplateCode; status?: PageStatus; body?: PageBlock[];
  seo?: { title?: string | null; description?: string | null; share_image_media_id?: string | null };
  add_to_menu?: NavigationHandle | null;
}  // title required unless template given
export interface UpdatePageInput {
  revision: number; title?: string; slug?: string; status?: PageStatus; body?: PageBlock[];
  seo?: { title?: string | null; description?: string | null; share_image_media_id?: string | null };
}

// ---------- Navigation ----------
export type NavigationHandle = 'main' | 'footer' | 'help';
export type NavLink =
  | { type: 'home' }
  | { type: 'page'; page_id: string }
  | { type: 'url'; url: string }
  | { type: 'collection'; handle: string }
  | { type: 'builtin'; target: 'track_order' | 'cart' | 'search' };
export interface NavItem { id: string; label: string; link: NavLink; children?: NavItem[] }
export type NavLinkStatus = 'ok' | 'page_unpublished' | 'page_missing';
export interface NavItemResolved extends Omit<NavItem, 'children'> {
  href: string | null; link_status: NavLinkStatus; page_title?: string | null; children?: NavItemResolved[];
}
export interface NavigationMenu {
  id: string; handle: NavigationHandle; title: string; items: NavItemResolved[];
  revision: number; updated_at: string;
}
export interface SaveNavigationInput { title?: string; items: NavItem[]; revision: number }

// ---------- Store SEO (StoreSettings / UpdateStoreSettingsInput additions) ----------
export interface StoreSeo { title: string | null; description: string | null; share_image: MediaRef | null; hide_from_search: boolean }

// ---------- Media list ----------
export interface MediaListFilters { purpose?: MediaPurpose[]; page?: number; per_page?: number }

// ---------- Storefront payload additions ----------
export interface StorefrontMedia {
  id: string; url: string; width: number; height: number; alt: string | null;
  srcset: { url: string; width: number }[];
}
export interface StorefrontNavItem { id: string; label: string; href: string; children: StorefrontNavItem[] }
export interface StorefrontNavMenu { title: string; items: StorefrontNavItem[] }
export interface StorefrontPage {
  id: string; slug: string; title: string; status: PageStatus; body: PageBlock[];
  media: Record<string, StorefrontMedia>;
  seo: { title: string | null; description: string | null; og_image_url: string | null };
  updated_at: string;
}
export interface StorefrontPageIndexEntry { slug: string; updated_at: string }

// ---------- Editor ↔ preview postMessage protocol ----------
export type EditorToPreviewMessage =
  | { source: 'storeplix-editor'; v: 1; type: 'refresh' }
  | { source: 'storeplix-editor'; v: 1; type: 'select'; section_id: string | null }
  | { source: 'storeplix-editor'; v: 1; type: 'scroll-to'; section_id: string };
export type PreviewToEditorMessage =
  | { source: 'storeplix-preview'; v: 1; type: 'ready'; path: string }
  | { source: 'storeplix-preview'; v: 1; type: 'section-click'; section_id: string }
  | { source: 'storeplix-preview'; v: 1; type: 'navigated'; path: string };

// ===================== Phase 4 (PHASE-4-CONTRACT §6) =====================
// ---------- Auth (Phase 4.7) ----------
/** Response of register / login / login/otp / invitation accept / password change after 4.7. */
export interface AuthSession { user: User; /** absolute session expiry, ISO-8601 */ expires_at: string }
export interface MeMeta {
  session_expires_at: string | null;
  /** Phase 8.1: set only in a read-only impersonation session (PHASE-8-1 P8-10). */
  impersonation?: MeImpersonation | null;
}

// ---------- Roles & permissions (Phase 8.3, PHASE-8-3 §2, §8) ----------
export type PermissionKey =
  | 'orders.view' | 'orders.process' | 'orders.refund' | 'fraud.manage' | 'shipments.manage' | 'shipments.cancel'
  | 'products.edit' | 'products.delete' | 'inventory.adjust' | 'purchasing.manage' | 'customers.view' | 'customers.edit'
  | 'customers.delete' | 'costs.view' | 'reports.view' | 'expenses.manage' | 'data.export' | 'data.import' | 'marketing.manage' | 'settings.manage'
  | 'integrations.manage' | 'domains.manage' | 'developers.manage' | 'staff.manage' | 'audit.view' | 'billing.view'
  | 'billing.manage';
export type PermissionGroupKey = 'orders' | 'shipping' | 'products' | 'customers' | 'money' | 'store' | 'team';

/**
 * §2.1 order (UI order); `billing.manage` last (owner only, never grantable). Phase 8.4 (PHASE-8-4 §2.1):
 * `developers.manage` (group `store`, sensitive) after `domains.manage`; owner + admin, never staff.
 * Phase 8.7 (PHASE-8-7 §2.1): `expenses.manage` (group `money`, sensitive) after `reports.view`; owner + admin, never staff.
 * Phase 8.8a (PHASE-8-8 §2.1): `fraud.manage` (group `orders`, sensitive, requires `orders.view`) after `orders.refund`;
 * owner + admin, never staff.
 * Phase 8.8b (PHASE-8-8B §2.1): `purchasing.manage` (group `products`, sensitive, requires `costs.view`) after
 * `inventory.adjust`; owner + admin, never staff. 26 grantable keys + owner-only `billing.manage`.
 */
export const PERMISSION_KEYS: readonly PermissionKey[] = [
  'orders.view', 'orders.process', 'orders.refund', 'fraud.manage', 'shipments.manage', 'shipments.cancel',
  'products.edit', 'products.delete', 'inventory.adjust', 'purchasing.manage', 'customers.view', 'customers.edit', 'customers.delete',
  'costs.view', 'reports.view', 'expenses.manage', 'data.export', 'data.import', 'marketing.manage', 'settings.manage',
  'integrations.manage', 'domains.manage', 'developers.manage', 'staff.manage', 'audit.view', 'billing.view', 'billing.manage',
];

/** §2.2 — mirrors App\Domain\Tenancy\Authorization\SystemRole. */
export const SYSTEM_ROLE_PERMISSIONS: Record<SystemRoleKey, readonly PermissionKey[]> = {
  owner: PERMISSION_KEYS,
  admin: PERMISSION_KEYS.filter((k) => k !== 'billing.manage'),
  staff: [
    'orders.view', 'orders.process', 'shipments.manage', 'shipments.cancel', 'products.edit',
    'inventory.adjust', 'customers.view', 'customers.edit', 'reports.view',
  ],
};

export interface PermissionDefinition {
  key: PermissionKey; label: string; description: string | null;
  requires: PermissionKey[]; sensitive: boolean; grantable: boolean;
}
export interface PermissionGroup { key: PermissionGroupKey; label: string; permissions: PermissionDefinition[] }
export interface RoleMemberPreview { id: string; name: string }
export interface Role {
  id: string; key: SystemRoleKey | null; name: string; description: string | null; is_system: boolean;
  permissions: PermissionKey[]; members_count: number; invitations_count: number; members_preview: RoleMemberPreview[];
  editable: boolean; revision: number; created_at: string; updated_at: string;
  updated_by: { id: string; name: string } | null;
}
export interface RoleMember {
  id: string; kind: 'member' | 'invitation'; user_id: string | null; name: string | null; email: string;
  phone: string | null; status: 'active' | 'invited' | 'expired'; is_you: boolean;
}
export interface RoleDetail extends Role { members: RoleMember[] }
export interface RolesMeta { custom_roles_used: number; custom_roles_limit: number; custom_roles_enabled: boolean }
export interface CreateRoleInput { name: string; description?: string | null; permissions: PermissionKey[] }
export interface UpdateRoleInput { revision: number; name?: string; description?: string | null; permissions?: PermissionKey[] }

// ---------- Catalog (Phase 4) ----------
export const DEFAULT_LOW_STOCK_THRESHOLD = 5;
export const CATALOG_LIMITS = {
  options: 3, option_values: 20, variants: 100, images: 10, categories_per_product: 10,
  tags: 20, category_depth: 3, categories_per_store: 500, bulk_ids: 100, adjustment_items: 100,
  max_amount: 1_000_000_000,
} as const;

export type ProductStatus = 'draft' | 'active' | 'archived';
export type ProductType = 'simple' | 'variable';
export interface ProductOption { name: string; values: string[] }
export interface CategoryRef { id: string; name: string; slug: string }

export interface Category {
  id: string; parent_id: string | null; name: string; slug: string; description: string | null;
  image: MediaRef | null; depth: 1 | 2 | 3; position: number; is_visible: boolean;
  url_path: string;                 // "/c/{slug}"
  product_count: number; children_count: number;
  created_at: string; updated_at: string;
}
export interface CreateCategoryInput {
  name: string; slug?: string; parent_id?: string | null; description?: string | null;
  image_media_id?: string | null; is_visible?: boolean;
}
export type UpdateCategoryInput = Partial<CreateCategoryInput>;
export interface ReorderCategoriesInput { items: { id: string; parent_id: string | null }[] }

export type StockStatus = 'in_stock' | 'low_stock' | 'out_of_stock' | 'untracked';
/**
 * Product editor / presenter `inventory` block. Since Phase 8.8c (P88C-6, §5.3) every number here is the **online
 * location's** stock row (= the default location); a missing row reads as 0.
 */
export interface InventoryLevel {
  on_hand: number; committed: number; available: number;
  low_stock_threshold: number | null; effective_threshold: number; status: StockStatus;
  /** Phase 8.8c: the online (default) location these numbers belong to. */
  location_id: string;
  /** Phase 8.8c: Σ on_hand over the variant's rows at non-archived locations. */
  total_on_hand: number;
  /** Phase 8.8c: `total_on_hand − on_hand` ("+ n at other locations" in the product editor). */
  other_locations_on_hand: number;
}
export interface ProductVariant {
  id: string; title: string; option_values: string[];      // ordered like Product.options
  sku: string | null; barcode: string | null;
  price_amount: number; compare_at_amount: number | null;
  cost_amount: number | null;                              // null for staff (ViewCosts)
  weight_grams: number | null; position: number; is_default: boolean; is_enabled: boolean;
  track_inventory: boolean; allow_backorder: boolean; image_media_id: string | null;
  inventory: InventoryLevel; updated_at: string;
}
export interface ProductImage { media_id: string; alt: string | null; position: number; media: MediaRef }
export interface ProductStockSummary { on_hand: number; available: number; low_variants: number; out_variants: number; tracked: boolean }
export interface ProductSummary {
  id: string; name: string; slug: string; type: ProductType; status: ProductStatus; currency: string;
  image: MediaRef | null;                                  // cover (first image)
  price_min_amount: number; price_max_amount: number;
  /** Card variant = cheapest enabled variant (first variant when none enabled). */
  price_amount: number; compare_at_amount: number | null; cost_amount: number | null;
  variants_count: number; first_sku: string | null;
  stock: ProductStockSummary; categories: CategoryRef[];
  published_at: string | null; created_at: string; updated_at: string;
}
export interface Product extends ProductSummary {
  description: RichTextDoc | null; tags: string[]; options: ProductOption[];
  variants: ProductVariant[]; images: ProductImage[];
  seo: { title: string | null; description: string | null };
  url_path: string;                                        // "/products/{slug}" (route ships in Phase 5)
  revision: number; created_by: UserRef | null; updated_by: UserRef | null;
}
export interface ProductVariantInput {
  id?: string; option_values?: string[]; sku?: string | null; barcode?: string | null;
  price_amount: number; compare_at_amount?: number | null; cost_amount?: number | null;
  weight_grams?: number | null; is_enabled?: boolean; track_inventory?: boolean; allow_backorder?: boolean;
  image_media_id?: string | null;
  /** New variants only. */
  initial_on_hand?: number;
  low_stock_threshold?: number | null;
}
export interface ProductImageInput { media_id: string; alt?: string | null }
export interface CreateProductInput {
  name: string; slug?: string; status?: ProductStatus; description?: RichTextDoc | null;
  tags?: string[]; category_ids?: string[]; options?: ProductOption[];
  variants: ProductVariantInput[]; images?: ProductImageInput[];
  seo?: { title?: string | null; description?: string | null };
}
export interface UpdateProductInput extends Partial<Omit<CreateProductInput, 'variants'>> {
  revision: number; variants?: ProductVariantInput[];
}
export type ProductSort = '-created_at' | 'created_at' | 'name' | '-name' | 'price' | '-price' | '-updated_at';
export interface ProductListFilters {
  status?: ProductStatus[]; category_id?: string; stock?: 'in' | 'low' | 'out'; q?: string;
  sort?: ProductSort; page?: number; per_page?: number;
}
export interface ProductListMeta extends PaginationMeta {
  counts: Record<'all' | ProductStatus, number>;
  summary: { active_products: number; active_variants: number; low_stock_variants: number; out_of_stock_variants: number };
  plan: { limit: number | null; used: number };
}
export type ProductBulkAction = 'activate' | 'draft' | 'archive' | 'delete' | 'set_categories' | 'add_categories';
export interface ProductBulkInput { action: ProductBulkAction; ids: string[]; category_ids?: string[] }
export interface ProductBulkResult { action: ProductBulkAction; updated: number }

// ---------- Locations (Phase 8.8c part A, PHASE-8-8C-CONTRACT §3.1, §4; openapi 1.18.0) ----------
export type LocationType = 'warehouse' | 'shop';
export const LOCATION_TYPES: readonly LocationType[] = ['warehouse', 'shop'];
export const LOCATION_TYPE_LABELS: Record<LocationType, string> = { warehouse: 'Warehouse', shop: 'Shop' };
/** P88C-2 bounds (WEB Zod mirrors these). */
export const LOCATION_NAME_MAX = 60;
export const LOCATION_ADDRESS_MAX = 200;
/** At most 10 non-archived locations per store. */
export const LOCATIONS_MAX = 10;
/** `{id, name}` summary used on movements, purchase orders, receipts and inventory rows. */
export interface LocationRef { id: string; name: string }
/**
 * `GET …/locations` item (sorted default first, then `position`, then name). `is_default` = the online location
 * ("Online orders ship from here", P88C-4). Exactly one default per store; a default is never archived.
 */
export interface Location {
  id: string;
  name: string;
  type: LocationType;
  address: string | null;
  is_default: boolean;
  position: number;
  archived_at: string | null;
  /** Optional link to a shipping pickup address (display + prefill only). */
  pickup_location: LocationRef | null;
  /** Σ on_hand at this location */
  units_on_hand: number;
  /** Σ on_hand × variant cost; null without `costs.view` */
  stock_value_amount: number | null;
  /** stock rows here with on_hand > 0 */
  variants_count: number;
  created_at: string;
  updated_at: string;
}
/** POST …/locations (201; plan `multi_warehouse` for the 2nd+ active location) and PATCH (partial). `settings.manage`. */
export interface LocationInput {
  name: string;
  type: LocationType;
  address?: string | null;
  pickup_location_id?: string | null;
}
export type UpdateLocationInput = Partial<LocationInput>;
/**
 * `GET …/locations` filter. `archived` omitted = every location (active and archived, so the Warehouses tab can offer
 * Unarchive); `false` = active only; `true` = archived only. Not paginated (≤ 10 active).
 */
export interface LocationListFilters { archived?: boolean }
/**
 * P88C-17 reasons in `error.details.reasons` of 409 `location_in_use` (archive). Part B: `open_transfers` = a draft or
 * in-transit transfer from or to it; `open_counts` = an in-progress count there.
 */
export type LocationInUseReason =
  | 'is_default' | 'has_stock' | 'has_committed' | 'open_purchase_orders' | 'open_transfers' | 'open_counts';
export const LOCATION_IN_USE_REASONS: readonly LocationInUseReason[] = [
  'is_default', 'has_stock', 'has_committed', 'open_purchase_orders', 'open_transfers', 'open_counts',
];
/** §9 error codes added by 8.8c part A (`insufficient_stock`, `feature_not_in_plan` already exist). */
export type LocationErrorCode = 'location_in_use' | 'location_name_taken' | 'location_locked' | 'location_archived';
/** P88C-18 audit actions (part A). */
export type LocationAuditAction =
  | 'location.created' | 'location.updated' | 'location.archived' | 'location.unarchived' | 'location.made_default';
export const LOCATION_AUDIT_ACTIONS: readonly LocationAuditAction[] = [
  'location.created', 'location.updated', 'location.archived', 'location.unarchived', 'location.made_default',
];

// ---------- Inventory ----------
/** Phase 8.8c: one location's numbers for a variant in `InventoryItem.locations`. */
export interface InventoryItemLocation { id: string; name: string; on_hand: number; committed: number; available: number }
/**
 * Phase 8.8c (§5.4): without `filter[location_id]` ("All locations") the top-level numbers are **totals** over
 * non-archived locations and `location_id` is null; with a filter they are that location's row only. Also the
 * external API item (`GET /external/…/inventory`), where without a filter top-level `on_hand`/`available` keep meaning
 * the **online location** (documented in openapi) and `locations[]` carries the per-location numbers.
 */
export interface InventoryItem {
  variant_id: string;
  product: { id: string; name: string; status: ProductStatus; image: MediaRef | null };
  title: string; option_values: string[]; sku: string | null; barcode: string | null;
  on_hand: number; committed: number; available: number;
  low_stock_threshold: number | null; effective_threshold: number; status: StockStatus;
  track_inventory: boolean; price_amount: number; cost_amount: number | null; updated_at: string;
  /**
   * Phase 8.8b (PHASE-8-8B §8.1, §10.1): units still expected on open purchase orders (`ordered` / `partially_received`;
   * Σ ordered − received − damaged). Always an integer (0 when none); visible to every inventory reader.
   */
  incoming: number;
  /** Phase 8.8c: the filtered location, null for "All locations". */
  location_id: string | null;
  /** Phase 8.8c: one entry per non-archived location (missing rows read as 0), default first then position. */
  locations: InventoryItemLocation[];
}
export interface InventorySummary {
  currency: string; stock_value_cost_amount: number | null; stock_value_price_amount: number;
  units_on_hand: number; committed_units: number; low_stock_variants: number; out_of_stock_variants: number;
  variants_count: number; products_count: number;
}
export interface InventoryListMeta extends PaginationMeta { summary: InventorySummary }
export interface InventoryListFilters {
  q?: string; stock?: ('in' | 'low' | 'out' | 'untracked')[];
  category_id?: string; product_id?: string;
  /** Phase 8.8c `filter[location_id]`; omitted = All locations (totals). */
  location_id?: string;
  sort?: 'name' | 'available' | '-available' | '-updated_at'; page?: number; per_page?: number;
}
/** Phase 8.8c adds `transfer_out`, `transfer_in` (stock transfers, part B) and `count` (stock counts, part B). */
export type StockMovementReason =
  | 'initial' | 'received' | 'correction' | 'damaged' | 'lost' | 'returned' | 'import' | 'other' | 'order_shipped'
  | 'order_returned' | 'transfer_out' | 'transfer_in' | 'count';
export type ManualStockReason = Exclude<
  StockMovementReason, 'initial' | 'import' | 'order_shipped' | 'order_returned' | 'transfer_out' | 'transfer_in' | 'count'
>;
export interface StockAdjustmentItem {
  variant_id: string; mode: 'delta' | 'set'; quantity: number; expected_on_hand?: number;
  /** Phase 8.8c (P88C-7): omitted = the default location. `expected_on_hand` / `set` apply to that location's row. */
  location_id?: string;
}
/** PATCH …/inventory/{variant} (threshold). Phase 8.8c: `location_id` omitted = the default location's row. */
export interface InventoryThresholdInput { low_stock_threshold: number | null; location_id?: string }
export interface StockAdjustmentInput { reason: ManualStockReason; note?: string | null; items: StockAdjustmentItem[] }
export interface StockMovement {
  id: string; variant_id: string; product: { id: string; name: string };
  variant_title: string; sku: string | null; delta: number; on_hand_after: number;
  reason: StockMovementReason; note: string | null;
  /**
   * `return` since 5b; `purchase_order` since 8.8b (reason `received`; `note` = "PO-0012 · {supplier name}", PHASE-8-8B §5.3).
   */
  reference: { type: StockMovementReferenceType; id: string } | null;
  /** Phase 8.4: a movement made with an API key renders `{ type: 'api_key', id, name: "API: <key name>" }`. */
  actor: UserRef | { type: 'api_key'; id: string; name: string } | null; created_at: string;
  /** Phase 8.8c: the stock row's location (every ledger row has one). */
  location: LocationRef;
}
/** Phase 8.8c adds `stock_transfer` and `stock_count` (part B). */
export type StockMovementReferenceType = 'import' | 'order' | 'return' | 'purchase_order' | 'stock_transfer' | 'stock_count';
export interface StockAdjustmentResult { items: InventoryItem[]; movements: StockMovement[] }
export interface StockMovementFilters {
  variant_id?: string; product_id?: string; reason?: StockMovementReason[];
  /** Phase 8.8b: `filter[reference_type]` (single value), e.g. `purchase_order`. */
  reference_type?: StockMovementReferenceType;
  /** Phase 8.8c `filter[location_id]`. */
  location_id?: string;
  created_from?: string; created_to?: string; page?: number; per_page?: number;
}  // api-client maps to filter[...] / filter[created_at][gte|lte]

// ---------- Customers ----------
export type CustomerChannel = 'facebook' | 'instagram' | 'whatsapp' | 'website' | 'phone' | 'walk_in' | 'other';
export interface Customer {
  id: string; name: string;
  phone: string | null;                                    // "8801XXXXXXXXX"
  email: string | null; district: string | null; area: string | null;
  channel: CustomerChannel | null; source: 'manual' | 'import' | 'storefront';
  tags: string[]; accepts_marketing: boolean;
  orders_count: number; total_spent_amount: number; currency: string; last_order_at: string | null;
  delivered_orders_count: number; returned_orders_count: number;
  notes_count: number; revision: number; created_at: string; updated_at: string; created_by: UserRef | null;
  /** Phase 8.5 (PHASE-8-5 §4.1): computed per-channel marketing status (suppressions + eligibility P85-3). */
  marketing: CustomerMarketing;
  /** Phase 8.8a (PHASE-8-8 §6.5): own-shop risk tier (P88-4); replaces the 8.5 risk class. Shown with `customers.view`. */
  risk: CustomerRisk;
}
export interface CustomerNote { id: string; body: string; author: UserRef | null; created_at: string; can_delete: boolean }
export interface CustomerDetail extends Customer { notes: CustomerNote[] }
export interface CreateCustomerInput {
  name: string; phone?: string | null; email?: string | null; district?: string | null; area?: string | null;
  channel?: CustomerChannel | null; tags?: string[]; accepts_marketing?: boolean;
}
export interface UpdateCustomerInput extends Partial<CreateCustomerInput> { revision: number }
export interface CustomerListFilters {
  q?: string; channel?: CustomerChannel[]; tag?: string; created_from?: string;
  /** Phase 8.8a (PHASE-8-8 §10.3): `filter[risk]=good,careful,risky,new` */
  risk?: RiskTier[];
  sort?: '-created_at' | 'name' | '-total_spent' | '-last_order_at'; page?: number; per_page?: number;
}
export interface CustomerListMeta extends PaginationMeta { counts: { all: number; new_this_month: number } }

// ---------- Imports / exports ----------
/** Phase 8.8b (P88B-15): `suppliers` is import-only (no export); needs `data.import` + `purchasing.manage`. */
export type DataImportType = 'products' | 'customers' | 'suppliers';
export type DataImportStatus = 'uploaded' | 'validating' | 'validated' | 'importing' | 'completed' | 'failed' | 'cancelled';
export type ProductImportField =
  | 'handle' | 'name' | 'description' | 'status' | 'category' | 'tags'
  | 'option1_name' | 'option1_value' | 'option2_name' | 'option2_value' | 'option3_name' | 'option3_value'
  | 'sku' | 'barcode' | 'price' | 'compare_at_price' | 'cost_price' | 'stock' | 'location' | 'weight_kg'
  | 'seo_title' | 'seo_description' | 'image_urls';
export type CustomerImportField = 'name' | 'phone' | 'email' | 'district' | 'area' | 'channel' | 'tags' | 'accepts_marketing' | 'note';
/** Phase 8.8b (P88B-15): match by phone, else by exact name (case-insensitive) among this store's suppliers. */
export type SupplierImportField =
  | 'name' | 'contact_name' | 'phone' | 'city' | 'supplies' | 'payment_terms_days' | 'lead_time_days'
  | 'pays_by_method' | 'pays_by_account' | 'notes';
export type ImportField = ProductImportField | CustomerImportField | SupplierImportField;
export interface ImportOptions { update_existing: boolean; import_as_draft: boolean; create_missing_categories: boolean }
export interface ImportSummary {
  total: number; create: number; update: number; unchanged: number;
  warnings: number; errors: number; over_limit: number;
}
export interface DataImport {
  id: string; type: DataImportType; status: DataImportStatus;
  filename: string; size_bytes: number; row_count: number | null;
  headers: string[]; samples: Record<string, string | null>;
  suggested_map: Record<string, ImportField | null>;
  column_map: Record<string, ImportField | null> | null;
  options: ImportOptions; summary: ImportSummary | null;
  progress: { processed: number; total: number };
  failure_reason: string | null; created_by: UserRef | null;
  created_at: string; validated_at: string | null; completed_at: string | null;
}
export interface ValidateImportInput { column_map: Record<string, ImportField | null>; options: ImportOptions }
export interface RunImportInput { allow_partial?: boolean }
export interface ImportRowMessage { level: 'warning' | 'error'; field: ImportField | null; message: string }
export interface DataImportRow {
  row_number: number; status: 'ready' | 'warning' | 'error';
  action: 'create' | 'update' | 'unchanged' | 'skip';
  label: string; key: string | null;
  preview: { price_amount: number | null; stock: number | null; variants: number | null };
  messages: ImportRowMessage[]; result_id: string | null;
}
export type DataExportStatus = 'queued' | 'running' | 'completed' | 'failed' | 'expired';
export interface DataExport {
  id: string; type: DataImportType; status: DataExportStatus; row_count: number | null;
  filename: string | null; download_url: string | null; expires_at: string | null;
  created_by: UserRef | null; created_at: string;
}
export type CreateExportInput =
  | { type: 'products'; filters?: Omit<ProductListFilters, 'page' | 'per_page' | 'sort'> & { ids?: string[] } }
  | { type: 'customers'; filters?: Omit<CustomerListFilters, 'page' | 'per_page' | 'sort'> };

// ---------- Dashboard ----------
export interface DashboardSummary {
  currency: string; timezone: string; generated_at: string;
  products: { total: number; active: number; draft: number; archived: number; limit: number | null };
  inventory: { low_stock_variants: number; out_of_stock_variants: number; units_on_hand: number; stock_value_cost_amount: number | null };
  customers: { total: number; new_this_month: number };
  /** null means "no order data yet" → empty states. */
  orders: OrderDashboard | null;
  setup: { has_products: boolean };
}

// ---------- Storefront product feed ----------
export interface StorefrontProductCard {
  id: string; slug: string; name: string;
  subtitle: string | null;                                 // first category name
  price_amount: number; compare_at_amount: number | null; currency: string;
  on_sale: boolean; image: StorefrontMedia | null;
}

// ==================== Phase 5a: Commerce (PHASE-5-CONTRACT §6) ====================
// ---------- Geo ----------
export interface BdDivision { code: string; name: string; name_bn: string }
export interface BdDistrict { code: string; division_code: string; name: string; name_bn: string }
export interface BdThana { code: string; district_code: string; name: string; name_bn: string; is_city: boolean }
export interface BdGeo { version: string; divisions: BdDivision[]; districts: BdDistrict[]; thanas: BdThana[] }

export type AddressLabel = 'home' | 'office';
export interface AddressInput {
  district_code: string; thana_code: string; area?: string | null;
  address_line: string; landmark?: string | null; label?: AddressLabel | null;
}
export interface Address extends Required<Omit<AddressInput, 'label'>> {
  division_code: string; division: string; district: string; thana: string; label: AddressLabel | null;
}

// ---------- Permissions (P5-21) ----------

// ---------- Shipping ----------
export interface ShippingZoneArea { district_code: string; thana_code: string | null; label: string }
export interface ShippingZone {
  id: string; name: string; kind: 'custom' | 'fallback'; charge_amount: number;
  min_days: number; max_days: number; is_active: boolean; position: number;
  areas: ShippingZoneArea[]; area_summary: string;        // "Dhaka city · 41 thanas"
}
export interface ShippingZoneInput {
  id?: string; name: string; kind: 'custom' | 'fallback'; charge_amount: number;
  min_days: number; max_days: number; is_active?: boolean;
  areas?: { district_code: string; thana_code?: string | null }[];
}
export interface PickupLocation {
  id: string; name: string; contact_name: string | null; contact_phone: string | null;
  district_code: string; thana_code: string; district: string; thana: string;
  address_line: string; is_default: boolean; created_at: string; updated_at: string;
}
export interface PickupLocationInput {
  name: string; contact_name?: string | null; contact_phone?: string | null;
  district_code: string; thana_code: string; address_line: string; is_default?: boolean;
}
export interface ShippingSettings {
  zones: ShippingZone[]; pickup_locations: PickupLocation[];
  free_delivery_over_amount: number | null; configured: boolean;
}
export interface SaveShippingInput { zones: ShippingZoneInput[]; free_delivery_over_amount: number | null }
export interface ShippingQuote {
  zone_id: string; zone_name: string; min_days: number; max_days: number;
  charge_amount: number;          // before free delivery
  amount: number;                 // what the shopper pays
  is_free: boolean;
}

// ---------- Store settings additions ----------
export type CustomerSmsEvent = 'order_placed' | 'order_confirmed' | 'order_shipped' | 'order_cancelled' | 'payment_link' | 'order_updated';
export interface StoreCommerceSettings {
  checkout: { cod_enabled: boolean; /** 5b */ cod_advance: 'none' | 'delivery_charge' };
  order_prefix: string;                      // effective prefix
  next_order_number: string;                 // "GS-1049"
  notifications: {
    new_order_email: boolean; sms_language: 'bn' | 'en';
    customer_sms: Record<CustomerSmsEvent, boolean>;
  };
  /** 5b */
  tax: { display: 'none' | 'included'; rate_bps: number; bin: string | null };
  invoice: { footer: string | null };
}

// ---------- Coupons ----------
export type CouponType = 'percentage' | 'fixed' | 'free_shipping';
export type CouponStatus = 'draft' | 'active' | 'disabled';
export type CouponDisplayStatus = CouponStatus | 'scheduled' | 'expired' | 'used_up';
export type CouponAppliesTo = 'all' | 'categories' | 'products';
export interface Coupon {
  id: string; code: string; type: CouponType;
  percent_bps: number | null; amount: number | null; max_discount_amount: number | null;
  applies_to: CouponAppliesTo; categories: CategoryRef[];
  products: { id: string; name: string; image: MediaRef | null; price_min_amount: number }[];
  min_subtotal_amount: number | null; usage_limit: number | null; usage_per_customer: number | null;
  first_order_only: boolean; starts_at: string; ends_at: string | null;
  status: CouponStatus; display_status: CouponDisplayStatus;
  stats: { used_count: number; orders_count: number; revenue_amount: number; discount_amount: number };
  share_path: string;                        // "/discount/WINTER15"
  revision: number; created_by: UserRef | null; created_at: string; updated_at: string;
}
export interface CreateCouponInput {
  code: string; type: CouponType; percent_bps?: number | null; amount?: number | null;
  max_discount_amount?: number | null; applies_to?: CouponAppliesTo;
  category_ids?: string[]; product_ids?: string[];          // ≤ 100 each
  min_subtotal_amount?: number | null; usage_limit?: number | null; usage_per_customer?: number | null;
  first_order_only?: boolean; starts_at?: string; ends_at?: string | null; status?: CouponStatus;
}
export interface UpdateCouponInput extends Partial<CreateCouponInput> { revision: number }
export interface CouponListFilters {
  q?: string; type?: CouponType[]; status?: CouponDisplayStatus[];
  sort?: '-created_at' | '-revenue' | '-used_count'; page?: number; per_page?: number;
}
export interface CouponListMeta extends PaginationMeta { counts: Record<'all' | 'active' | 'scheduled' | 'expired', number> }

// ---------- Storefront catalog ----------
export interface StorefrontProductQuery {
  sort?: 'latest' | 'bestsellers' | 'price_asc' | 'price_desc'; limit?: number; page?: number; per_page?: number;
  on_sale?: boolean; category?: string; q?: string; price_min?: number; price_max?: number;
  in_stock?: boolean; exclude?: string;
}   // replaces the Phase 4 StorefrontProductQuery (superset)
export interface StorefrontProductListMeta extends Partial<PaginationMeta> { has_products: boolean }
export interface StorefrontVariant {
  id: string; title: string; option_values: string[];
  price_amount: number; compare_at_amount: number | null; image_media_id: string | null;
}
export interface StorefrontProduct {
  id: string; slug: string; name: string; description: RichTextDoc | null;
  options: ProductOption[]; variants: StorefrontVariant[];      // enabled variants only
  images: { media_id: string; alt: string | null; media: StorefrontMedia }[];
  price_min_amount: number; price_max_amount: number; currency: string;
  categories: { slug: string; name: string }[];                 // first = primary for breadcrumb
  seo: { title: string | null; description: string | null };
  url_path: string; is_preview_only: boolean; updated_at: string;
}
export interface StorefrontAvailability {
  variants: { id: string; available: boolean; low_stock: number | null }[];
}
export interface StorefrontCategory {
  slug: string; name: string; image: StorefrontMedia | null; url_path: string;   // "/c/{slug}"
  children: StorefrontCategory[];
}
export interface StorefrontCategoryDetail extends Omit<StorefrontCategory, 'children'> {
  description: string | null; ancestors: { slug: string; name: string }[];
  children: { slug: string; name: string; url_path: string }[];
}
export interface StorefrontCommerce {
  checkout_enabled: boolean; payment_methods: PaymentMethod[];
  free_delivery_over_amount: number | null;
  delivery: { name: string; charge_amount: number; min_days: number; max_days: number }[];
  /** 5b */
  cod_advance: 'none' | 'delivery_charge';
}

// ---------- Cart ----------
export type CartLineIssue = 'unavailable' | 'insufficient_stock';
export interface CartLine {
  id: string; variant_id: string; product_slug: string; product_name: string; variant_title: string;
  option_values: string[]; image: StorefrontMedia | null; quantity: number;
  unit_price_amount: number; compare_at_amount: number | null; line_amount: number;
  issue: CartLineIssue | null; max_quantity: number | null; low_stock: number | null;
}
export interface Cart {
  lines: CartLine[]; lines_count: number; items_count: number; currency: string;
  coupon: { code: string; type: CouponType; discount_amount: number; free_shipping: boolean } | null;
  subtotal_amount: number; discount_amount: number; savings_amount: number; estimated_total_amount: number;
  free_delivery: { threshold_amount: number; remaining_amount: number } | null;
  can_checkout: boolean;
}
export interface CartMeta { cart_token?: string; notices?: string[] }

// ---------- Checkout / storefront orders ----------
export type PaymentMethod = 'cod' | 'bkash' | 'sslcommerz';
export interface CheckoutInput {
  contact: { name: string; phone: string; email?: string | null };
  shipping_address: AddressInput; payment_method: PaymentMethod;
  customer_note?: string | null; accepts_marketing?: boolean; expected_total_amount: number;
  /** 5b: COD order with the delivery charge paid in advance */
  advance_gateway?: GatewayProvider | null;
  /**
   * Phase 8.8a (PHASE-8-8 §7, P88-13): 6-digit code from `POST /storefront/checkout/otp` when it answered
   * `required: true`. Missing → 422 `otp_required`; wrong → 422 `otp_invalid` (`details.attempts_left`).
   */
  otp_code?: string | null;
}
export interface StorefrontOrderLine {
  product_name: string; variant_title: string; quantity: number; image: StorefrontMedia | null;
  unit_price_amount: number; total_amount: number;
}
export interface StorefrontOrder {
  number: string; status: OrderStatus; payment_method: PaymentMethod; placed_at: string;
  customer_name: string; customer_phone: string; shipping_address: Address;
  lines: StorefrontOrderLine[]; coupon_code: string | null;
  subtotal_amount: number; discount_amount: number; shipping_amount: number; total_amount: number;
  due_amount: number; currency: string; delivery: { zone_name: string; min_days: number | null; max_days: number | null };
  /** 5b */
  payment: StorefrontPaymentState | null; paid_amount: number;
}
export interface CheckoutResult { order: StorefrontOrder; confirmation_token: string; /** 5b */ payment: PaymentInitiation | null }
export interface TrackOrderInput { number: string; phone: string }
export interface StorefrontOrderTracking {
  number: string; status: OrderStatus; placed_at: string;
  shipping: { district: string; thana: string };
  lines: StorefrontOrderLine[]; total_amount: number; due_amount: number; currency: string;
  timeline: { status: OrderStatus; at: string }[];
  shipment: {
    carrier_name: string | null; tracking_code: string | null; tracking_url: string | null;
    /** 5b-3 (§11): courier status and times only, never rider data, location or courier text */
    status: ShipmentStatus | null; status_at: string | null; checked_at: string | null;
    events: { status: ShipmentStatus; at: string }[];
  } | null;
}

// ---------- Orders (merchant) ----------
export type OrderStatus = 'pending_payment' | 'pending' | 'confirmed' | 'ready_to_ship' | 'shipped' | 'delivered' | 'returned' | 'cancelled';
export type PaymentStatus = 'unpaid' | 'partially_paid' | 'paid' | 'partially_refunded' | 'refunded';
export type OrderChannel = 'website' | 'facebook' | 'instagram' | 'whatsapp' | 'phone' | 'walk_in' | 'landing_page' | 'other';
export type CancelReason = 'customer_request' | 'fake_order' | 'unreachable' | 'out_of_stock' | 'duplicate' | 'other' | 'payment_timeout' | 'payment_link_expired';
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending_payment: ['confirmed', 'pending', 'cancelled'], pending: ['confirmed', 'cancelled'], confirmed: ['ready_to_ship', 'shipped', 'cancelled'],
  ready_to_ship: ['shipped', 'confirmed', 'cancelled'], shipped: ['delivered', 'returned'],
  delivered: [], returned: [], cancelled: [],
};
export interface OrderCustomerSummary {
  id: string | null; name: string; phone: string; email: string | null;
  orders_count: number; delivered_orders_count: number; returned_orders_count: number;
  total_spent_amount: number;
  /** Phase 8.8a (PHASE-8-8 §6.5): own-shop tier of the customer row (or of the phone when `id` is null). */
  risk: CustomerRisk;
}
export interface OrderSummary {
  id: string; number: string; status: OrderStatus; payment_status: PaymentStatus; payment_method: PaymentMethod;
  channel: OrderChannel; created_via: 'storefront' | 'dashboard';
  customer: OrderCustomerSummary; district: string; thana: string;
  items_count: number; total_amount: number; paid_amount: number; due_amount: number; currency: string;
  coupon_code: string | null; tags: string[]; placed_at: string; updated_at: string;
  /** 5b */
  shipment: { provider: Shipment['provider']; status: ShipmentStatus; consignment_id: string | null } | null;
  return_status: OrderReturnStatus;
  /** Phase 8.8a (PHASE-8-8 §6.5): fake-order guard state; null when the order has no check and no hold. */
  guard: OrderGuard | null;
}
export interface OrderItem {
  id: string; product_id: string | null; variant_id: string | null;
  product_name: string; variant_title: string; option_values: string[]; sku: string | null;
  image: MediaRef | null; unit_price_amount: number; compare_at_amount: number | null;
  unit_cost_amount: number | null;                         // null for staff (ViewCosts)
  quantity: number; subtotal_amount: number; discount_amount: number; total_amount: number;
  restocked_quantity: number;
  current_stock: { available: number; tracked: boolean } | null;   // "43 in stock"; null when variant deleted
}
export interface OrderEvent {
  id: string; type: 'placed' | 'status_changed' | 'note' | 'edited' | 'payment' | 'refund' | 'shipment' | 'notification' | 'coupon_released'
    | 'payment_link' | 'items_edited' | 'return' | 'document'
    /** Phase 8.8a: guard decision / release (`meta`: `decision`, `hold`, `tier`, `rate`, `reasons`). */
    | 'guard';
  from_status: OrderStatus | null; to_status: OrderStatus | null;
  /** Phase 8.4: `api_key` = written through the external API (`id` = key id, `name` = "API: <key name>", `user` null). */
  actor: { type: 'user' | 'customer' | 'system'; user: UserRef | null } | { type: 'api_key'; user: null; id: string; name: string };
  body: string | null; meta: Record<string, unknown>; created_at: string;
}
export interface Payment {
  id: string; provider: PaymentProvider; type: 'charge' | 'refund';
  status: 'pending' | 'succeeded' | 'failed' | 'cancelled'; amount: number; currency: string;
  method: RefundMethod | null; reference: string | null; note: string | null;
  actor: UserRef | null; created_at: string;
  /** 5b */
  purpose: PaymentPurpose; provider_trx_id: string | null; refunded_amount: number;
  expires_at: string | null; failure_code: string | null; payment_link_id: string | null;
  return_request_id: string | null; can_refund: boolean;
}
export interface Shipment {
  id: string; provider: 'manual' | CourierProvider; carrier_name: string | null;
  tracking_code: string | null; tracking_url: string | null; status: ShipmentStatus;
  cod_amount: number; shipped_at: string | null; delivered_at: string | null; returned_at: string | null;
  /** 5b */
  consignment_id: string | null; provider_status: string | null; attempts: number; problem: ShipmentProblem | null;
  weight_grams: number | null; delivery_fee_amount: number | null; cod_charge_amount: number | null;
  cod_collected_amount: number | null; last_location: string | null; last_event_at: string | null;
  booked_at: string | null; picked_up_at: string | null; cancelled_at: string | null; failure_reason: string | null;
}
export interface Order extends OrderSummary {
  contact: { name: string; phone: string; email: string | null };
  shipping_address: Address; customer_note: string | null;
  items: OrderItem[]; events: OrderEvent[]; payments: Payment[]; shipment: Shipment | null;
  subtotal_amount: number; discount_amount: number; shipping_amount: number; shipping_discount_amount: number;
  tax_amount: number; refunded_amount: number;
  shipping_zone_name: string; delivery_min_days: number | null; delivery_max_days: number | null; shipping_overridden: boolean;
  cancel_reason: CancelReason | null;
  timestamps: Partial<Record<'confirmed_at' | 'shipped_at' | 'delivered_at' | 'returned_at' | 'cancelled_at', string>>;
  allowed_transitions: OrderStatus[];                      // already filtered by role
  can: { edit: boolean; cancel: boolean; refund: boolean };
  revision: number; created_by: UserRef | null;
  /** 5b */
  shipments: Shipment[]; payment_expires_at: string | null;
  payment_links: PaymentLink[]; invoice_printed_at: string | null; label_printed_at: string | null;
  source_order_id: string | null;
}
export interface OrderListFilters {
  status?: OrderStatus[]; payment_status?: PaymentStatus[]; channel?: OrderChannel[]; district_code?: string;
  customer_id?: string; coupon_id?: string; placed_from?: string; placed_to?: string; q?: string;
  sort?: '-placed_at' | 'placed_at' | '-total'; page?: number; per_page?: number;
  /** 5b */
  printed?: 'invoice' | 'label'; not_printed?: 'invoice' | 'label';
  /** 5b-3: `filter[has_shipment]=0|1` (active courier or manual shipment) */
  has_shipment?: boolean;
  /** Phase 8.8a (PHASE-8-8 §6.5): `filter[risk]` = `guard.tier`, else the customer's tier */
  risk?: RiskTier[];
  /** Phase 8.8a: `filter[guard_hold]=1` → held orders only (`guard.hold` not null) */
  guard_hold?: boolean;
}
/** Phase 8.8a: `counts.held` = orders with `guard.hold` not null (any status, ignores the status filter like the rest). */
export interface OrderListMeta extends PaginationMeta { counts: Record<'all' | OrderStatus | 'held', number> }
export interface ManualOrderInput extends Omit<CheckoutInput, 'expected_total_amount' | 'payment_method'> {
  items: { variant_id: string; quantity: number }[]; channel: Exclude<OrderChannel, 'website'>;
  payment_method?: 'cod'; coupon_code?: string | null; shipping_amount_override?: number | null;
  customer_id?: string | null; notify_customer?: boolean;
}
export interface OrderQuote {
  lines: (Omit<OrderItem, 'id' | 'restocked_quantity'> & { issue: CartLineIssue | null })[];
  zone: ShippingQuote | null; coupon_error: string | null;
  subtotal_amount: number; discount_amount: number; shipping_amount: number; total_amount: number;
  customer: OrderCustomerSummary | null;                   // matched by phone in this store
}
export interface UpdateOrderInput {
  revision: number; contact?: { name?: string; phone?: string; email?: string | null };
  shipping_address?: AddressInput; customer_note?: string | null; tags?: string[];
}
export interface ShipOrderInput { carrier_name?: string | null; tracking_code?: string | null; tracking_url?: string | null; notify_customer?: boolean }
export interface ReturnOrderInput { restock: { item_id: string; quantity: number }[]; note?: string | null }
export interface CancelOrderInput { reason: CancelReason; note?: string | null; notify_customer?: boolean; /** 5b */ refund_to_gateway?: boolean }
export type RefundMethod = 'cash' | 'bkash_personal' | 'nagad_personal' | 'bank' | 'other' | 'gateway';
export interface RefundInput { amount: number; method: RefundMethod; reference?: string | null; note?: string | null; /** 5b */ payment_id?: string | null; return_id?: string | null }
export interface OrderBulkInput { action: 'confirm' | 'ready'; ids: string[] }
export interface OrderBulkResult { action: 'confirm' | 'ready'; updated: number; skipped: { id: string; reason: string }[] }

// ---------- Go-live ----------
export type LaunchItemKey = 'products' | 'shipping' | 'payments' | 'contact_phone' | 'policy_pages' | 'first_order';
export interface LaunchChecklist {
  status: 'draft' | 'active'; can_publish: boolean; published_at: string | null; shop_url: string;
  items: { key: LaunchItemKey; required: boolean; done: boolean; href: string }[];
}

// ---------- Dashboard ----------
export interface OrderDashboard {
  this_month: {
    count: number; sales_amount: number; delivered_count: number; returned_count: number;
    cancelled_count: number; delivery_success_rate: number | null;   // 0..1
  };
  waiting: { pending: number; confirmed: number; ready_to_ship: number; /** 5b-2: orders awaiting online payment */ pending_payment: number;
    /** 5b-3: confirmed / ready_to_ship orders with no active courier shipment */ to_book: number };
  /** 5b-3: active shipments the courier flagged */
  shipments: { problems: number };
  best_sellers: { product_id: string; name: string; image: MediaRef | null; units: number }[];
  plan: { used: number; limit: number | null };
}

// ==================== Phase 5b: online money, couriers, documents, order changes (PHASE-5B-CONTRACT §9) ====================
// Note: `ReturnType` below shadows TypeScript's global ReturnType<T> inside this module only; this file never uses the global.
// ---------- Integrations (shared) ----------
export type GatewayProvider = 'bkash' | 'sslcommerz';
export type CourierProvider = 'steadfast' | 'pathao' | 'redx';
export type IntegrationMode = 'sandbox' | 'live';
export type IntegrationStatus = 'not_connected' | 'connected' | 'error' | 'disconnected';

// ---------- Payment gateways ----------
export interface PaymentGatewayAccount {
  provider: GatewayProvider; status: IntegrationStatus; mode: IntegrationMode | null;
  credentials_hint: string | null;            // "••••3f9a"; never the secret
  enabled: boolean; is_default: boolean;
  verified_at: string | null; last_checked_at: string | null; last_error_code: string | null;
  connected_by: UserRef | null; connected_at: string | null; revision: number;
}
export type BkashCredentialsInput = { app_key: string; app_secret: string; username: string; password: string };
export type SslcommerzCredentialsInput = { store_id: string; store_passwd: string };
export interface ConnectGatewayInput { mode: IntegrationMode; credentials: BkashCredentialsInput | SslcommerzCredentialsInput }
export interface UpdateGatewayInput { revision: number; enabled?: boolean; is_default?: boolean }
export interface GatewayTestPayment { payment_id: string; redirect_url: string }

// ---------- Payments (extends 5a) ----------
export type PaymentProvider = 'cod' | 'manual' | GatewayProvider;
export type PaymentPurpose = 'order' | 'advance' | 'link' | 'exchange' | 'test';
export interface PaymentInitiation {
  payment_id: string; provider: GatewayProvider;
  status: 'redirect' | 'initiation_failed';
  redirect_url: string | null; amount: number; expires_at: string;
}
export interface StorefrontPaymentState {
  status: 'pending' | 'succeeded' | 'failed' | 'cancelled';
  provider: GatewayProvider; purpose: PaymentPurpose; amount: number;
  expires_at: string | null;                  // order hold end (pending_payment only)
  can_retry: boolean; can_switch_to_cod: boolean;
}
export interface StorefrontPaymentResult {
  status: 'pending' | 'succeeded' | 'failed' | 'cancelled';
  order_number: string; amount: number; currency: string; purpose: PaymentPurpose; shop_name: string;
}
export interface StorefrontPayInput { payment_method: PaymentMethod }

// ---------- Payment links ----------
export type PaymentLinkAmountKind = 'delivery_charge' | 'percent' | 'full' | 'custom';
export interface PaymentLink {
  id: string; order_id: string; amount_kind: PaymentLinkAmountKind; percent_bps: number | null;
  amount: number; currency: string; provider: GatewayProvider;
  status: 'active' | 'paid' | 'expired' | 'cancelled';
  url: string;                                // https://{primary_host}/pay/{token}
  expires_at: string; cancel_if_unpaid: boolean; sent_via: ('sms')[];
  paid_at: string | null; created_by: UserRef | null; created_at: string;
}
export interface CreatePaymentLinkInput {
  amount_kind: PaymentLinkAmountKind; percent_bps?: number | null; amount?: number | null;
  provider: GatewayProvider; expires_in_minutes: 120 | 360 | 1440 | 2880;
  cancel_if_unpaid: boolean; send_sms: boolean;
}
export interface PaymentLinkView {
  order_number: string; shop_name: string; amount: number; currency: string;
  provider: GatewayProvider; expires_at: string; status: 'active';
}

// ---------- Couriers ----------
export interface CourierSettings {
  pickup_location_id: string | null; parcel_description: string; default_weight_grams: number;
  pathao_store_id?: string | null; delivery_type?: 48 | 12; redx_pickup_store_id?: string | null;
}
export interface CourierAccount {
  provider: CourierProvider; status: IntegrationStatus; mode: IntegrationMode | null;
  credentials_hint: string | null; is_default: boolean; settings: CourierSettings;
  webhook_url: string | null; webhook_secret_hint: string | null;
  capabilities: ('bulk' | 'cancel' | 'areas' | 'quote' | 'webhook')[];
  last_synced_at: string | null; last_webhook_at: string | null; last_error_code: string | null;
  connected_by: UserRef | null; connected_at: string | null; revision: number;
}
export interface ConnectCourierInput {
  mode: IntegrationMode;
  credentials: { api_key: string; secret_key: string }
    | { client_id: string; client_secret: string; username: string; password: string }
    | { access_token: string };
  settings?: Partial<CourierSettings>;
}
export interface UpdateCourierInput { revision: number; settings?: Partial<CourierSettings>; is_default?: boolean }
export interface CourierArea { id: string; name: string; level: 'city' | 'zone' | 'area'; parent_id: string | null }

// ---------- Shipments (extends 5a Shipment) ----------
export type ShipmentStatus =
  | 'booking' | 'booked' | 'picked_up' | 'in_transit' | 'out_for_delivery' | 'on_hold' | 'delivery_failed'
  | 'delivered' | 'partially_delivered' | 'returning' | 'returned' | 'cancelled' | 'booking_failed' | 'shipped';
export type ShipmentProblem = 'delivery_failed' | 'on_hold' | 'returning' | 'unknown';
export type OrderReturnStatus = 'none' | 'requested' | 'partially_returned' | 'returned';
export interface ShipmentEvent {
  id: string; status: ShipmentStatus; provider_status: string | null; description: string | null;
  location: string | null; source: 'webhook' | 'poll' | 'user' | 'system'; occurred_at: string;
}
export interface ShipmentSummary extends Shipment {
  order: { id: string; number: string; customer_name: string; customer_phone: string; district: string; thana: string };
  age_days: number;
}
export interface ShipmentDetail extends ShipmentSummary {
  events: ShipmentEvent[];
  money: { collect_amount: number; delivery_fee_amount: number | null; cod_charge_amount: number | null; net_amount: number | null };
  parcel: { items_summary: string; weight_grams: number | null; pickup_location: string | null };
  can: { cancel: boolean; mark_cancelled: boolean; refresh: boolean };
}
export interface ShipmentListMeta extends PaginationMeta {
  counts: Record<'all' | CourierProvider | 'manual', number>;
  kpis: {
    in_transit: number; out_for_delivery_today: number; delivered_7d: number; delivery_rate_7d: number | null;
    problems: { total: number; delivery_failed: number; on_hold: number; returning: number };
    cod_held: { total_amount: number; by_provider: { provider: CourierProvider; amount: number; parcels: number }[] };
  };
  last_synced_at: string | null;
}
export interface ShipmentListFilters {
  provider?: (CourierProvider | 'manual')[]; status?: (ShipmentStatus | 'problems' | 'active' | 'final')[];
  booked_from?: string; booked_to?: string; q?: string; sort?: '-booked_at' | '-cod'; page?: number; per_page?: number;
}
export interface BookShipmentInput {
  provider: CourierProvider; pickup_location_id?: string | null; cod_amount?: number | null;
  weight_grams?: number | null; item_description?: string | null; note?: string | null; delivery_type?: 48 | 12;
  area?: { city_id: string | null; zone_id: string | null; area_id: string | null } | null; remember_area?: boolean;
}
export interface ShipmentBatch {
  id: string; provider: CourierProvider; status: 'queued' | 'running' | 'completed' | 'failed';
  total: number; booked: number; skipped: number; failed: number;
  results: { order_id: string; order_number: string; shipment_id: string | null; status: 'booked' | 'skipped' | 'failed'; reason: string | null }[];
  created_at: string; finished_at: string | null;
}

// ---------- Documents ----------
export type DocumentKind = 'invoice_a4' | 'receipt_80mm' | 'invoice_a5_two_up' | 'packing_slip' | 'label_4x6';
export interface DocumentTemplateConfig {
  show_logo: boolean; show_bin: boolean; show_product_names: boolean; show_prices: boolean; show_sku: boolean;
  language: 'en' | 'bn'; footer_text: string | null;
}
export interface DocumentTemplate {
  kind: DocumentKind; config: DocumentTemplateConfig; paper: { width_mm: number; height_mm: number | null; label: string };
  is_default: boolean; revision: number; updated_at: string | null;
}
export interface CreateDocumentInput { kind: DocumentKind; order_ids: string[]; language?: 'en' | 'bn' }
export interface StoreDocument {
  id: string; kind: DocumentKind; status: 'queued' | 'rendering' | 'ready' | 'failed' | 'expired';
  orders_count: number; pages: number | null; download_url: string | null; expires_at: string | null;
  error_code: string | null; created_at: string;
}

// ---------- Order changes ----------
export type EditItemsReason = 'customer_request' | 'out_of_stock' | 'wrong_item' | 'other';
export interface EditOrderItemsInput {
  revision: number; items: { id?: string | null; variant_id?: string | null; quantity: number }[];
  reason: EditItemsReason; note?: string | null; recalculate_shipping?: boolean;
  shipping_amount_override?: number | null; notify_customer?: boolean;
}
export interface OrderItemsQuote {
  lines: (Omit<OrderItem, 'id' | 'restocked_quantity'> & { id: string | null; change: 'unchanged' | 'changed' | 'added' | 'removed'; issue: CartLineIssue | null })[];
  subtotal_amount: number; discount_amount: number; shipping_amount: number; total_amount: number;
  previous_total_amount: number; due_amount: number; due_delta_amount: number; notices: string[];
}
export interface RestockInput { lines: { item_id: string; quantity: number }[]; note?: string | null }
export type ReturnType = 'return' | 'exchange';
export type ReturnStatus = 'requested' | 'approved' | 'received' | 'refunded' | 'exchanged' | 'rejected' | 'closed';
export type ReturnReason = 'wrong_size' | 'damaged' | 'wrong_item' | 'changed_mind' | 'refused_at_door' | 'other';
export interface ReturnItem {
  id: string; order_item_id: string; product_name: string; variant_title: string; image: MediaRef | null;
  quantity: number; amount: number; restocked_quantity: number;
  exchange_variant: { id: string; title: string; price_amount: number; available: number | null } | null;
}
export interface ReturnSummary {
  id: string; number: string; type: ReturnType; status: ReturnStatus; reason: ReturnReason; source: 'merchant' | 'courier';
  order: { id: string; number: string }; customer: { name: string; phone: string };
  items_preview: { product_name: string; variant_title: string; quantity: number }[];
  requested_amount: number; refunded_amount: number; courier: CourierProvider | 'manual' | null; created_at: string;
}
export interface ReturnEvent {
  id: string; type: 'created' | 'status_changed' | 'note' | 'refund' | 'restock';
  from_status: ReturnStatus | null; to_status: ReturnStatus | null;
  actor: { type: 'user' | 'customer' | 'system'; user: UserRef | null }; body: string | null; meta: Record<string, unknown>; created_at: string;
}
export interface ReturnRequest extends ReturnSummary {
  customer_note: string | null; pickup_tracking_code: string | null;
  checks: { tags_intact?: boolean; unused?: boolean; original_packaging?: boolean };
  items: ReturnItem[]; events: ReturnEvent[]; exchange_order: { id: string; number: string } | null;
  price_difference_amount: number | null;     // exchange: new total − credit
  allowed_transitions: ReturnStatus[]; revision: number;
}
export interface CreateReturnInput {
  type: ReturnType; reason: ReturnReason; customer_note?: string | null;
  lines: { order_item_id: string; quantity: number; exchange_variant_id?: string | null }[];
}
export interface ReceiveReturnInput {
  checks: { tags_intact: boolean; unused: boolean; original_packaging: boolean };
  lines: { return_item_id?: string; order_item_id?: string; restock_quantity: number; quantity?: number }[];
}
export interface ReturnListMeta extends PaginationMeta {
  counts: Record<'open' | ReturnStatus, number>;
  kpis: { open: number; return_rate_30d: number | null; money_lost_amount: number; restocked_units_month: number };
}
export interface ExchangeOrderInput {
  shipping_amount_override?: number | null;
  send_payment_link?: { provider: GatewayProvider; expires_in_minutes: 120 | 360 | 1440 | 2880 } | null;
}

// ==================== Phase 6: custom domains (PHASE-6-CONTRACT §6) ====================
export type DomainType = 'platform' | 'custom';
export type DomainFailureCode =
  | 'txt_missing' | 'txt_mismatch' | 'cname_missing' | 'cname_mismatch' | 'dns_error' | 'verification_timeout'
  | 'provider_error' | 'provider_blocked' | 'provider_moved' | 'ssl_validation_failed' | 'ssl_timeout' | 'ssl_lost'
  | 'suspended'
  | 'plan_limit';
export type DnsRecordStatus = 'pending' | 'ok' | 'missing' | 'mismatch';
export interface DomainDnsRecord {
  purpose: 'ownership' | 'routing';
  type: 'TXT' | 'CNAME';
  /** FQDN, e.g. "_storeplix-verify.shop.acme.com" */
  name: string;
  /** relative to the registrable domain: "@", "shop", "_storeplix-verify.shop" */
  name_relative: string;
  /** "sp-verify=<token>" or the CNAME target */
  value: string;
  status: DnsRecordStatus;
  /** values the resolvers returned at the last check (≤ 5, each ≤ 255 chars) */
  found: string[];
}
export type DomainSslStatus = 'none' | 'pending' | 'active' | 'failed';
export interface StoreDomain {
  id: string;
  /** lowercase ASCII (punycode) */
  hostname: string;
  /** Unicode form for display (equals hostname for ASCII names) */
  display_hostname: string;
  type: DomainType;
  status: DomainStatus;
  is_primary: boolean;
  is_apex: boolean;
  /** status === 'active' and the store is not suspended */
  routable: boolean;
  /** [] for platform rows */
  dns_records: DomainDnsRecord[];
  ssl_status: DomainSslStatus;
  verification_started_at: string | null;
  verified_at: string | null;
  activated_at: string | null;
  status_changed_at: string | null;
  last_checked_at: string | null;
  next_check_at: string | null;
  /** the 72 h / 24 h / 7-day deadline that applies now, else null */
  deadline_at: string | null;
  failure_code: DomainFailureCode | null;
  failure_message: string | null;
  /** include role, type, status and plan; all false for staff */
  can_recheck: boolean;
  can_make_primary: boolean;
  can_remove: boolean;
  created_at: string;
  updated_at: string;
}
export interface AddDomainInput { hostname: string }
export interface DomainListMeta {
  /** e.g. "customers.storeplix.com" */
  cname_target: string;
  /** "_storeplix-verify" */
  txt_prefix: string;
  can_add: boolean;
  feature_enabled: boolean;
  limit: { used: number; max: number | null };
}
/** GET /internal/domains/allowed (6.5, server-to-server only) */
export interface DomainAllowed { allowed: true }

// ==================== Phase 7: monetization (PHASE-7-CONTRACT §9) ====================
export type BillingInterval = 'month' | 'year';
export interface Plan {
  id: string; code: 'free' | 'starter' | 'growth' | (string & {}); name: string;
  price_amount: number; currency: string; interval: 'month' | 'year';
  limits: Record<LimitKey, number | null>; features: FeatureKey[];
  /** Phase 7 (P7-3): yearly price (10 × monthly); null = no yearly option (Free) */
  price_yearly_amount: number | null;
}
export interface SubscriptionScheduledChange { plan: Plan; interval: BillingInterval; effective_at: string }
export interface Subscription {
  id: string; status: SubscriptionStatus; plan: Plan;
  trial_ends_at: string | null; current_period_start: string | null; current_period_end: string | null;
  cancel_at_period_end: boolean;
  /** Phase 7 */
  billing_interval: BillingInterval;
  scheduled_change: SubscriptionScheduledChange | null;
  past_due_at: string | null; grace_ends_at: string | null; domain_grace_ends_at: string | null;
  open_invoice: BillingInvoiceSummary | null;
}
export interface FeatureAccess {
  plan_code: string; subscription_status: SubscriptionStatus; trial_ends_at: string | null;
  features: Record<FeatureKey, boolean>;
  limits: Record<LimitKey, { limit: number | null; used: number }>;
  /** Phase 7: end of the past_due grace (null unless past_due) and the custom-domain detach date (P7-16) */
  grace_ends_at: string | null; domain_grace_ends_at: string | null;
}

export type BillingInvoiceKind = 'new' | 'upgrade' | 'renewal';
export type BillingInvoiceStatus = 'open' | 'paid' | 'void';
export type BillingVoidReason = 'superseded' | 'expired' | 'unpaid' | 'cancelled' | 'manual';
export interface BillingInvoiceLine {
  description: string; plan_code: string | null; interval: BillingInterval | null;
  period_start: string | null; period_end: string | null;
  quantity: number; unit_amount: number; amount: number;
}
export interface BillingInvoiceSummary {
  id: string; number: string; kind: BillingInvoiceKind; status: BillingInvoiceStatus;
  description: string; total_amount: number; currency: 'BDT';
  issued_at: string; due_at: string; paid_at: string | null; is_overdue: boolean; can_pay: boolean;
}
export interface BillingBillTo { name: string; address: string | null; email: string | null; phone: string | null }
export type BillingPaymentStatus = 'pending' | 'succeeded' | 'failed' | 'cancelled';
export interface BillingPayment {
  id: string; invoice_id: string; provider: GatewayProvider | 'manual'; status: BillingPaymentStatus;
  amount: number; currency: 'BDT';
  /** Only while pending and not expired; an https provider page (http://localhost fake page in dev). */
  redirect_url: string | null;
  failure_code: string | null; is_duplicate: boolean;
  created_at: string; expires_at: string; verified_at: string | null;
}
export interface BillingInvoice extends BillingInvoiceSummary {
  plan_code: string; interval: BillingInterval;
  subtotal_amount: number; tax_amount: number; tax_rate_bps: number; credit_amount: number;
  lines: BillingInvoiceLine[]; bill_to: BillingBillTo;
  period_start: string | null; period_end: string | null;
  voided_at: string | null; void_reason: BillingVoidReason | null; paid_late: boolean;
  payments: BillingPayment[];
}
export interface BillingInvoiceListMeta extends PaginationMeta { providers: GatewayProvider[] }
export interface BillingQuoteInput { plan_code: string; interval: BillingInterval }
export type BillingChangeKind = 'new' | 'upgrade' | 'downgrade' | 'cancel';
export interface BillingDowngradeWarning {
  key: LimitKey | FeatureKey; used: number | null; limit: number | null; message: string;
}
export interface BillingQuote {
  kind: BillingChangeKind; plan: Plan; interval: BillingInterval;
  amount: number; credit_amount: number; currency: 'BDT';
  requires_payment: boolean; effective_at: string;
  period_start: string | null; period_end: string | null;
  lines: BillingInvoiceLine[]; warnings: BillingDowngradeWarning[];
}
export interface ChangePlanResult { subscription: Subscription; invoice: BillingInvoice | null }
export interface PayInvoiceInput { provider: GatewayProvider }

// ---------- Reports (PHASE-7-CONTRACT §6.3–6.4) ----------
export interface ReportRangeQuery { from?: string; to?: string }  // YYYY-MM-DD, store-local
export interface ReportMeta {
  from: string; to: string; previous_from: string; previous_to: string;
  timezone: string; currency: string; generated_at: string;
}
export interface SalesSummary {
  sales_amount: number; sold_orders_count: number; orders_count: number; orders_per_day: number;
  average_order_value_amount: number | null; items_per_order: number | null;
  cancelled_count: number; cancelled_rate: number | null; fake_cancelled_count: number;
}
export interface SalesReport {
  summary: SalesSummary; previous: SalesSummary;
  best_day: { date: string; sales_amount: number; orders_count: number } | null;
  weekend_share: number | null;
  daily: { date: string; orders_count: number; sold_orders_count: number; sales_amount: number }[];
  channels: { channel: OrderChannel; orders_count: number; sales_amount: number; share: number }[];
  top_products: { product_id: string | null; name: string; image: MediaRef | null; units: number; sales_amount: number; share: number }[];
  areas: {
    inside_dhaka_share: number | null;
    districts: { district_code: string; district_name: string; orders_count: number; sales_amount: number; share: number }[];
  };
}
/**
 * PHASE-7 §6.4 as amended by PHASE-8-7 §7.1: expenses count on their `spent_on` local date. `ad_spend_amount` = Σ
 * category `ads` (never null since 8.7); `other_expenses_amount` = Σ the other five categories; `total_cost_amount`
 * and `net_profit_amount` include both; `profit_before_expenses_amount` = the Phase 7 net profit.
 */
export interface ProfitSummary {
  revenue_amount: number; delivered_orders_count: number;
  product_cost_amount: number; delivery_cost_amount: number; cod_fee_amount: number;
  gateway_fee_amount: number | null; ad_spend_amount: number; other_expenses_amount: number;
  total_cost_amount: number; profit_before_expenses_amount: number; net_profit_amount: number; margin: number | null;
  profit_per_order_amount: number | null;
}
export interface ProfitReport {
  summary: ProfitSummary; previous: ProfitSummary;
  per_order: {
    order_value_amount: number; product_cost_amount: number; delivery_cost_amount: number;
    cod_fee_amount: number; gateway_fee_amount: number | null;
    /** PHASE-8-7 §7.1: floor(expense / delivered orders); `per_order` stays null with no delivered orders. */
    ad_spend_amount: number; other_expenses_amount: number;
    profit_amount: number;
  } | null;
  weekly: { week: string; week_start: string; revenue_amount: number; net_profit_amount: number; margin: number | null }[];
  daily: ({ date: string; orders_count: number } & Omit<ProfitSummary, 'delivered_orders_count' | 'profit_per_order_amount'>)[];
  /** `expenses_count` (PHASE-8-7): expense rows dated in the range. */
  data_quality: { items_without_cost: number; shipments_without_fee: number; expenses_count: number };
}
export interface DeliverySummary {
  parcels_count: number; delivered_count: number; returned_count: number; returning_count: number;
  in_progress_count: number; success_rate: number | null; return_rate: number | null;
  returning_charges_amount: number;
  avg_delivery_days: number | null; avg_delivery_days_inside_dhaka: number | null; avg_delivery_days_outside_dhaka: number | null;
}
export interface DeliveryReport {
  summary: DeliverySummary; previous: DeliverySummary;
  couriers: {
    provider: CourierProvider; parcels_count: number; delivered_share: number; returned_share: number;
    in_progress_share: number; avg_delivery_days: number | null; cod_held_amount: number;
  }[];
  returns_count: number;
  return_reasons: { reason: ReturnReason; count: number; share: number }[];
  weekly: { week: string; week_start: string; parcels_count: number; success_rate: number | null }[];
  returning: {
    shipment_id: string; order_id: string; order_number: string; customer_name: string; district_name: string | null;
    provider: CourierProvider; problem: string | null; last_location: string | null; last_event_at: string | null;
  }[];
  districts: { district_code: string; district_name: string; parcels_count: number; success_rate: number | null }[];
}

// ---------- Phase 8.1: super admin (PHASE-8-1-CONTRACT; openapi 1.9.0) ----------
/**
 * Phase 8.4: `api_key` = a call made through the external API (`actor.id` = key id, PHASE-8-4 §3).
 * Phase 8.6 (P86-20): `automation` = a store automation (`actor.id` = automation id, `actor.name` = automation name).
 */
export type AuditActorType = 'user' | 'system' | 'platform_user' | 'api_key' | 'automation';
export type PlatformRole = 'super_admin' | 'billing' | 'support' | 'read_only';
export type PlatformPermission =
  | 'view_merchants' | 'impersonate' | 'manage_billing' | 'manage_domains' | 'suspend' | 'manage_team'
  /** Phase 8.2 (PHASE-8-2 §2.1): super_admin, billing, read_only */
  | 'view_analytics';
export type SuspensionReasonCode = 'unpaid' | 'fraud' | 'terms_violation' | 'merchant_request' | 'other';
export type AdminPlanChangeEffective = 'now' | 'next_renewal';
export type ImpersonationStatus = 'pending' | 'active' | 'ended' | 'expired';
export type AdminTenantStatus = 'active' | 'suspended';
export type AdminTenantTab = 'all' | 'active' | 'paying' | 'trial' | 'past_due' | 'suspended';
export type AdminDomainState = 'all' | 'dns_pending' | 'ssl_failing' | 'active' | 'suspended' | 'expired';

export interface AdminLoginInput { email: string; password: string }
export type AdminTotpInput = { login_token: string; code: string } | { login_token: string; recovery_code: string };
export interface AdminLoginStep { step: 'totp' | 'enroll'; login_token: string; expires_at: string }
export interface TotpEnrollment { otpauth_uri: string; qr_svg: string; secret: string }
export interface PlatformUser {
  id: string; name: string; email: string; platform_role: PlatformRole; permissions: PlatformPermission[];
  totp_enrolled: boolean; recovery_codes_left: number;
}
export interface AdminSession { user: PlatformUser; session_expires_at: string; idle_expires_at: string }
export interface PlatformInvitationLookup { email: string; role: PlatformRole; existing_user: boolean }
export interface AcceptPlatformInvitationInput { name?: string; password: string; password_confirmation?: string }

export interface AdminShopRef { id: string; name: string; slug: string }
export interface AdminOwner { id: string; name: string; email: string; phone: string | null }
export interface AdminTenantSummary {
  id: string; name: string; status: AdminTenantStatus;
  /** null while the merchant has not created their shop yet (onboarding) */
  store: { id: string; name: string; slug: string; status: 'draft' | 'active' | 'suspended'; primary_host: string } | null;
  owner: AdminOwner | null;
  plan_code: string; billing_interval: BillingInterval | null; subscription_status: SubscriptionStatus | null;
  trial_ends_at: string | null; current_period_end: string | null; created_at: string;
  /** Phase 8.2 (P82-16): last merchant-dashboard request by any member, 15-min resolution; null = never */
  last_active_at: string | null;
  /** Phase 8.2: snapshot on `as_of`; null when the tenant has no snapshot row yet */
  metrics: AdminTenantMetricsSummary | null;
}
export interface AdminTenantCounts { all: number; paying: number; trial: number; past_due: number; suspended: number }
export interface AdminTenant extends AdminTenantSummary {
  suspension: { suspended_at: string; reason_code: SuspensionReasonCode; store_status_before: 'draft' | 'active' } | null;
  subscription: Subscription | null;
  usage: { key: LimitKey; used: number; limit: number | null }[];
  member_count: number; domain_count: number; lifetime_paid_amount: number;
  open_invoice: AdminInvoiceSummary | null;
}
export interface AdminTenantMember {
  id: string | null; name: string | null; email: string; phone: string | null;
  role: TenantRole; role_name: string; status: 'active' | 'invited'; joined_at: string | null;
}
export interface AdminDomain {
  id: string; hostname: string; tenant: AdminShopRef; kind: 'platform' | 'custom'; status: DomainStatus;
  failure_code: DomainFailureCode | null; is_primary: boolean; dns_ok: boolean | null; ssl_ok: boolean | null;
  last_checked_at: string | null; created_at: string;
}
export interface AdminInvoiceSummary {
  id: string; number: string; tenant: AdminShopRef; kind: string; status: BillingInvoiceStatus; plan_code: string;
  billing_interval: BillingInterval; total_amount: number; currency: 'BDT'; provider: string | null;
  issued_at: string; due_at: string | null; paid_at: string | null;
}
export interface AdminInvoice extends BillingInvoice {
  tenant: AdminShopRef;
  payments: (BillingPayment & { provider_reference: string | null; is_duplicate: boolean })[];
}
export interface AdminOverview {
  tenants: { total: number; active: number; suspended: number };
  subscriptions: { paying: number; trialing: number; free: number; past_due: number; by_plan: { plan_code: string; count: number }[] };
  past_due: { count: number; amount: number; currency: 'BDT' };
  open_invoices: number;
  domains: { active: number; pending: number; failing: number; suspended: number };
  active_impersonations: number;
  newest_tenants: AdminTenantSummary[];
}
export interface AdminSearchResult { tenants: AdminTenantSummary[]; domains: AdminDomain[]; invoices: AdminInvoiceSummary[] }
export interface AdminAuditEntry {
  id: string; action: string;
  actor: { type: AuditActorType; id: string | null; name: string | null; email: string | null };
  tenant: AdminShopRef | null;
  subject: { type: string; id: string } | null;
  reason: string | null; ip: string | null; user_agent: string | null;
  meta: Record<string, unknown> | null; impersonation_id: string | null; created_at: string;
}
export interface CursorMeta { next_cursor: string | null; prev_cursor: string | null; per_page: number }

export interface Impersonation {
  id: string; status: ImpersonationStatus; staff: { id: string; name: string; email: string }; tenant: AdminShopRef;
  reason: string; ticket_ref: string | null; started_at: string | null; expires_at: string | null; ended_at: string | null;
  ended_by: 'staff' | 'expiry' | 'revoked' | null; request_count: number; created_at: string;
}
export interface ImpersonationTicket { id: string; url: string; ticket_expires_at: string }
/** `/auth/me` meta.impersonation (merchant app) */
export interface MeImpersonation {
  id: string; tenant_id: string; tenant_name: string; owner_name: string | null; reason: string; expires_at: string;
}
export interface ImpersonationStart { user: User; impersonation: MeImpersonation; session_expires_at: string }

export interface PlatformStaff {
  id: string; kind: 'user' | 'invitation'; name: string | null; email: string; role: PlatformRole;
  status: 'active' | 'invited' | 'disabled' | 'locked'; totp_enrolled: boolean; invited_at: string | null;
  /** invitations only */
  expires_at: string | null;
}
export interface PlatformInvitation { id: string; email: string; role: PlatformRole; expires_at: string; created_at: string }
export interface PlatformRoleMatrix {
  roles: PlatformRole[]; permissions: PlatformPermission[]; grants: Partial<Record<PlatformRole, PlatformPermission[]>>;
}
export interface PlatformTeamMeta {
  counts: { all: number; active: number; invited: number; disabled: number };
  matrix: PlatformRoleMatrix;
  security: { totp_required: true; ip_allowlist_enabled: boolean; session_idle_minutes: number; impersonation_minutes: number };
}

export interface AdminSuspendInput { reason_code: SuspensionReasonCode; reason: string; notify: boolean }
export interface AdminReactivateInput { reason: string; notify: boolean }
export interface AdminQuoteInput { plan_code: string; interval: BillingInterval; effective: AdminPlanChangeEffective }
export interface AdminChangePlanInput extends AdminQuoteInput { reason: string; notify: boolean }
export interface AdminExtendInput { days: number; reason: string }
export interface AdminMarkPaidInput { reference: string; reason: string }
export interface AdminReasonInput { reason: string }
export interface CreateImpersonationInput { reason: string; ticket_ref?: string | null }
export interface InvitePlatformStaffInput { email: string; role: PlatformRole }
export interface UpdatePlatformStaffInput { role: PlatformRole; reason: string }

/** Phase 8.1 (P8-12): the whole `/storefront/config` answer for a suspended shop. */
export interface StorefrontSuspended { availability: 'suspended' }
export type StorefrontConfigResponse = StorefrontConfig | StorefrontSuspended;
export function isStorefrontSuspended(c: StorefrontConfigResponse): c is StorefrontSuspended {
  return (c as StorefrontSuspended).availability === 'suspended';
}

// ---------- Phase 8.2: platform analytics (PHASE-8-2-CONTRACT; openapi 1.10.0) ----------
/** Money: integer paisa (BDT). Rates/shares: fractions in [0, 1], 4 decimals. Days and months are Asia/Dhaka. */
export type AnalyticsRange = '30d' | 'quarter' | '12m' | 'custom';
export type AnalyticsGranularity = 'day' | 'week' | 'month';
export interface AnalyticsQuery { range?: AnalyticsRange; from?: string; to?: string; granularity?: AnalyticsGranularity }
export type AdminTenantSort =
  | '-created_at' | 'created_at' | 'name' | '-name' | 'current_period_end' | '-current_period_end'
  | '-mrr' | 'mrr' | '-gmv_30d' | '-orders_30d' | '-last_active_at' | 'last_active_at';
export interface AnalyticsMeta {
  /** latest computed Dhaka day; null before the first nightly run */
  as_of: string | null; computed_at: string | null; data_starts_on: string | null;
  timezone: 'Asia/Dhaka'; currency: 'BDT';
  range: AnalyticsRange; granularity: AnalyticsGranularity;
  from: string; to: string; previous_from: string; previous_to: string;
}
export interface AdminTenantMetricsSummary { as_of: string; mrr_amount: number; is_comp: boolean; orders_30d: number; gmv_30d_amount: number }
export interface AnalyticsPlanRef { code: string; name: string; sort: number; monthly_price_amount: number }
export interface AnalyticsPlanCount { plan_code: string; plan_name: string; count: number }
export interface AnalyticsMrrPoint { bucket_start: string; bucket_end: string; mrr_amount: number | null; by_plan: Record<string, number> }
export interface AdminAnalyticsOverview {
  mrr: { amount: number | null; previous_amount: number | null; arr_amount: number | null };
  active_shops: {
    total: number | null; paying: number | null; trialing: number | null; comp: number | null; free: number | null;
    past_due: number | null; previous_total: number | null;
  };
  trial_conversion: { rate: number | null; previous_rate: number | null; converted: number; ended: number; trialing_now: number | null };
  gmv: {
    amount: number | null; previous_amount: number | null; orders_count: number | null; previous_orders_count: number | null;
    aov_amount: number | null;
  };
  revenue_churn: {
    rate: number | null; previous_rate: number | null; churned_amount: number | null; cancellations: number | null;
    opening_mrr_amount: number | null;
  };
  mrr_series: AnalyticsMrrPoint[];
  plan_mix: AnalyticsPlanCount[];
  plans: AnalyticsPlanRef[];
}
export interface AnalyticsAmountPair { amount: number | null; previous_amount: number | null }
/** P82-9: money fields are null together when the window lacks snapshots (then `counts` is null too). */
export interface MrrMovementBucket {
  bucket_start: string; bucket_end: string;
  opening_mrr_amount: number | null; new_amount: number | null; expansion_amount: number | null;
  contraction_amount: number | null; churned_amount: number | null; net_new_amount: number | null;
  closing_mrr_amount: number | null;
  counts: { new: number; expansion: number; contraction: number; churned: number } | null;
}
/** P82-14: cohort = Dhaka month (YYYY-MM) of the first paid invoice; retention[k] = month cohort+k */
export interface RetentionCohort { cohort: string; size: number; retention: (number | null)[] }
export interface RevenueByPlanRow {
  plan_code: string; plan_name: string; monthly_price_amount: number;
  /** paying shops on the plan; Free row = free shops */
  shops: number | null;
  mrr_amount: number | null; previous_mrr_amount: number | null; share: number | null; yearly_share: number | null;
}
export interface TopPayingMerchant {
  tenant: AdminShopRef; primary_host: string | null; plan_code: string; billing_interval: BillingInterval | null;
  last_payment_provider: 'bkash' | 'sslcommerz' | 'manual' | null;
  orders_30d: number; mrr_amount: number; customer_since: string | null; lifetime_paid_amount: number;
}
export interface AdminRevenueReport {
  kpis: {
    mrr: AnalyticsAmountPair; arr: AnalyticsAmountPair;
    net_new_mrr: AnalyticsAmountPair & {
      new_amount: number | null; expansion_amount: number | null; contraction_amount: number | null; churned_amount: number | null;
    };
    churned_mrr: AnalyticsAmountPair & {
      rate: number | null; previous_rate: number | null; opening_mrr_amount: number | null; count: number | null;
    };
    arpa: AnalyticsAmountPair & { paying: number | null };
    ltv: { amount: number | null; lifetime_months: number | null };
  };
  movement: MrrMovementBucket[];
  cohorts: { rows: RetentionCohort[]; m3_average: number | null };
  by_plan: {
    rows: RevenueByPlanRow[];
    total: { shops: number | null; paying: number | null; mrr_amount: number | null; previous_mrr_amount: number | null };
  };
  trial_funnel: {
    signed_up: number; store_published: number; trial_ended: number; converted: number;
    trial_to_paid_rate: number | null; signup_to_paid_rate: number | null; median_days_to_paid: number | null;
  };
  top_merchants: TopPayingMerchant[];
}
export interface AdminTenantMetrics {
  mrr_amount: number | null; is_comp: boolean; plan_code: string | null; billing_interval: BillingInterval | null;
  orders_30d: number | null; previous_orders_30d: number | null;
  gmv_30d_amount: number | null; previous_gmv_30d_amount: number | null; aov_30d_amount: number | null;
  avg_orders_per_day_30d: number | null; gmv_month_amount: number | null; paid_12m_amount: number;
  /** 12 Dhaka months ending with as_of's month, oldest first */
  monthly: { month: string; gmv_amount: number | null; orders_count: number | null }[];
}

// ---------- Phase 8.4: developer API keys + outbound webhooks (PHASE-8-4-CONTRACT §2, §6; openapi 1.12.0) ----------
/** §2.2 scopes, UI order. `*:write` implies the matching `*:read`. */
export type ApiScope =
  | 'orders:read' | 'orders:write' | 'products:read' | 'products:write' | 'inventory:read' | 'inventory:write'
  | 'customers:read';
export const API_SCOPES: readonly ApiScope[] = [
  'orders:read', 'orders:write', 'products:read', 'products:write', 'inventory:read', 'inventory:write', 'customers:read',
];
export type ApiScopeGroup = 'orders' | 'products' | 'inventory' | 'customers';
/** GET /api-scopes item. `backing_permission` null = base access (any member); `grantable` is for the signed-in actor (P84-5). */
export interface ApiScopeInfo {
  key: ApiScope; label: string; group: ApiScopeGroup; backing_permission: PermissionKey | null;
  implies: ApiScope[]; grantable: boolean;
}
/** P84-14: active (non-revoked) keys per tenant; endpoints per store. External API: 120 requests / minute per key. */
export const DEVELOPER_LIMITS = { api_keys: 10, webhook_endpoints: 5, external_requests_per_minute: 120 } as const;

export type ApiKeyStatus = 'active' | 'revoked';
export interface ApiKey {
  id: string; name: string;
  /** first 12 chars, e.g. `sp_live_ab12` */
  prefix: string; last_four: string;
  /** e.g. `sp_live_••••7f2a` */
  masked: string;
  scopes: ApiScope[]; include_costs: boolean; status: ApiKeyStatus; created_at: string;
  created_by: { id: string; name: string } | null; last_used_at: string | null; revoked_at: string | null;
}
/** POST /api-keys (201) only: `plain_key` (`sp_live_` + 40 base62) is never returned again. */
export interface ApiKeyCreated extends ApiKey { plain_key: string }
export interface CreateApiKeyInput { name: string; scopes: ApiScope[]; include_costs?: boolean }
/** Rename only. */
export interface UpdateApiKeyInput { name: string }
/** GET /external/me (API-key auth). */
export interface ApiKeyIdentity {
  id: string; name: string; scopes: ApiScope[]; tenant_id: string;
  store: { id: string; name: string; currency: string };
}

/** §4.1 subscribable events, UI order (Figma "Events you can send"). `ping` exists only on test deliveries. */
export type WebhookEventType =
  | 'order.created' | 'order.confirmed' | 'order.cancelled' | 'order.paid' | 'shipment.updated' | 'shipment.delivered'
  | 'return.received' | 'product.updated' | 'stock.low' | 'customer.created';
export const WEBHOOK_EVENT_TYPES: readonly WebhookEventType[] = [
  'order.created', 'order.confirmed', 'order.cancelled', 'order.paid', 'shipment.updated', 'shipment.delivered',
  'return.received', 'product.updated', 'stock.low', 'customer.created',
];
export type WebhookDeliveryEventType = WebhookEventType | 'ping';
export interface WebhookEventTypeInfo { key: WebhookEventType; label: string; description: string }
export const WEBHOOK_API_VERSION = '2026-12-01';

export type WebhookDisabledReason = 'manual' | 'failing';
export interface WebhookEndpoint {
  id: string; url: string; description: string | null; events: WebhookEventType[]; is_active: boolean;
  disabled_reason: WebhookDisabledReason | null; failing_since: string | null; last_delivery_at: string | null;
  /** HTTP status of the last attempt (null = none yet or no response) */
  last_status: number | null;
  /** 0–100, one decimal; null when there were no deliveries in the last 7 days */
  success_rate_7d: number | null;
  created_at: string; updated_at: string;
}
export interface CreateWebhookEndpointInput { url: string; events: WebhookEventType[]; description?: string | null }
export interface UpdateWebhookEndpointInput {
  url?: string; events?: WebhookEventType[]; description?: string | null; is_active?: boolean;
}

export interface WebhookSecret {
  last_four: string;
  /** e.g. `whsec_••••3kQ9` */
  masked: string;
  rotated_at: string | null;
  /** the previous secret still signs (second `v1=`) until this time; null when no overlap */
  previous_expires_at: string | null;
}
/** reveal / rotate: `secret` = `whsec_` + 32 base62. After rotate it is the new secret (shown once). */
export interface WebhookSecretRevealed extends WebhookSecret { secret: string }

export type WebhookDeliveryStatus = 'pending' | 'retrying' | 'succeeded' | 'failed';
export type WebhookDeliveryErrorCode =
  | 'timeout' | 'connection_failed' | 'url_not_allowed' | 'http_error' | 'plan' | 'endpoint_disabled';
export interface WebhookDelivery {
  id: string; endpoint_id: string; event_id: string; event_type: WebhookDeliveryEventType;
  /** e.g. order number `GS-1048` */
  subject_label: string | null;
  status: WebhookDeliveryStatus; attempts: number; next_attempt_at: string | null; last_attempt_at: string | null;
  response_status: number | null; error_code: WebhookDeliveryErrorCode | null; duration_ms: number | null;
  created_at: string;
}
/** §4.2 body (same event `id` across resends). `data.object` = the external-API resource of the subject. */
export interface WebhookPayload {
  id: string; type: WebhookDeliveryEventType; /** `2026-12-01` (WEBHOOK_API_VERSION) */ api_version: string; created_at: string;
  store_id: string; data: { object: Record<string, unknown> };
}
export interface WebhookDeliveryDetail extends WebhookDelivery {
  payload: WebhookPayload;
  /** sent headers; `X-Storeplix-Signature` value redacted */
  request_headers: Record<string, string>;
  response_body_excerpt: string | null;
}
export interface WebhookDeliveryFilters {
  endpoint_id?: string; status?: WebhookDeliveryStatus; event_type?: WebhookDeliveryEventType; cursor?: string;
}
export interface WebhookResendFailedResult { count: number }

// ---------- Phase 8.5: marketing campaigns SMS + email (PHASE-8-5-CONTRACT §3–§6; openapi 1.13.0) ----------
/** P85-1: one channel per campaign. WhatsApp is out of scope (hidden). */
export type MarketingChannel = 'sms' | 'email';
export type CampaignChannel = MarketingChannel;
export const CAMPAIGN_CHANNELS: readonly CampaignChannel[] = ['sms', 'email'];
/** Campaign language: SMS footer, `{name}` fallback ("গ্রাহক" / "there"). */
export type CampaignLanguage = 'bn' | 'en';
/** P85-17 state machine: `draft → scheduled → sending → sent`; `draft|scheduled|sending → cancelled`; `scheduled|sending → failed`. */
export type CampaignStatus = 'draft' | 'scheduled' | 'sending' | 'sent' | 'cancelled' | 'failed';
export const CAMPAIGN_STATUSES: readonly CampaignStatus[] = ['draft', 'scheduled', 'sending', 'sent', 'cancelled', 'failed'];
export type CampaignFailureReason = 'limit' | 'plan' | 'store_unavailable' | 'no_recipients';

/** §3.2 predefined segments (UI order). No saved/custom segments in 8.5 (Q143). */
export type CampaignSegment = 'all' | 'repeat_inactive' | 'vip' | 'new_customers' | 'one_time' | 'district' | 'tag';
export const CAMPAIGN_SEGMENTS: readonly CampaignSegment[] = [
  'all', 'repeat_inactive', 'vip', 'new_customers', 'one_time', 'district', 'tag',
];
/** §3.2 parameter defaults and bounds (server validates; WEB pre-fills). `vip.min_spent_amount` is minor units. */
export const CAMPAIGN_SEGMENT_PARAMS = {
  repeat_inactive: { min_orders: { default: 2, min: 2, max: 20 }, inactive_days: { default: 60, min: 14, max: 365 } },
  vip: { min_spent_amount: { default: 2_000_000, min: 1 } },
  new_customers: { days: { default: 30, min: 1, max: 365 } },
  district: { districts: { min: 1, max: 10 } },
  tag: { tag: { min_length: 1, max_length: 40 } },
} as const;
export interface CampaignAudienceExclude {
  /** risk tier `risky` (PHASE-8-8 P88-4; was P85-25) */
  risky: boolean;
  /** null or 1–60 (Figma default 7) */
  ordered_within_days: number | null;
}
/**
 * `audience` jsonb (§3.2). `params` is always present (`{}` for `all` / `one_time`). Unknown keys → 422.
 * Opted-out and ineligible customers (P85-3) are always excluded — not a flag.
 */
export type CampaignAudience = (
  | { segment: 'all'; params: Record<string, never> }
  | { segment: 'repeat_inactive'; params: { min_orders: number; inactive_days: number } }
  | { segment: 'vip'; params: { min_spent_amount: number } }
  | { segment: 'new_customers'; params: { days: number } }
  | { segment: 'one_time'; params: Record<string, never> }
  | { segment: 'district'; params: { districts: string[] } }
  | { segment: 'tag'; params: { tag: string } }
) & { exclude: CampaignAudienceExclude };

/** §1 limits the UI mirrors (server is authoritative). */
export const CAMPAIGN_LIMITS = {
  name_max: 80,
  /** P85-18: SMS parts incl. the `"{shop}: "` prefix and the opt-out footer */
  sms_max_parts: 5,
  /** shop name in the SMS prefix is truncated to this many chars */
  sms_prefix_shop_name_max: 20,
  email_subject_max: 150,
  email_body_max: 5000,
  /** P85-16 */
  schedule_min_lead_minutes: 5,
  schedule_max_days: 90,
  /** P85-15 quiet hours, store time: no start from 21:00 until 09:00 */
  quiet_hours: { from: '21:00', to: '09:00' },
  /** P85-27 */
  non_terminal_per_store: 50,
  sending_per_store: 3,
  /** P85-26 test sends per user per hour */
  test_sends_per_hour: 5,
  /** P85-21 attribution window */
  attribution_days: 7,
} as const;

/** Merge fields (P85-20). Anything else in `{…}` → 422 `campaign_unknown_merge_field`. */
export type CampaignMergeField = '{name}' | '{coupon}' | '{shop_link}' | '{product}';
export const CAMPAIGN_MERGE_FIELDS: readonly CampaignMergeField[] = ['{name}', '{coupon}', '{shop_link}', '{product}'];

export interface CampaignStats {
  recipients: number; sent: number; failed: number; skipped: number; unsubscribed: number;
  /** SMS parts sent (0 for email) */
  parts_sent: number;
  /** attributed orders (P85-21), cancelled excluded */
  orders: number; revenue_amount: number; currency: string;
}
/** `CampaignListItem` = `Campaign` without `body` / `subject` / `audience` (§6.2). */
export interface CampaignListItem {
  id: string; name: string; channel: CampaignChannel; language: CampaignLanguage; status: CampaignStatus;
  /** server-rendered segment label in the campaign language, e.g. "Bought 2+ times, inactive 60 days" */
  audience_label: string;
  coupon: { id: string; code: string } | null;
  product: { id: string; name: string; slug: string } | null;
  scheduled_at: string | null; started_at: string | null; completed_at: string | null; cancelled_at: string | null;
  failure_reason: CampaignFailureReason | null;
  stats: CampaignStats;
  created_by: UserRef | null; created_at: string; updated_at: string; revision: number;
}
export interface Campaign extends CampaignListItem {
  audience: CampaignAudience;
  /** merchant text with merge fields; never includes the auto prefix/footer */
  body: string;
  /** email only (null for SMS) */
  subject: string | null;
}
export interface CreateCampaignInput {
  name: string; channel: CampaignChannel; language: CampaignLanguage; audience: CampaignAudience; body: string;
  /** required for email (1–150, no CR/LF), must be null/absent for SMS */
  subject?: string | null;
  coupon_id?: string | null; product_id?: string | null;
  /**
   * Remembered schedule time. Stored on a draft (no effect until `/schedule`); on a `scheduled` campaign a change is
   * re-validated (P85-15/16, allowance P85-14).
   */
  scheduled_at?: string | null;
}
/** PATCH — `draft` / `scheduled` only (else 409 `invalid_state_transition`); `revision` required (409 `revision_conflict`). */
export interface UpdateCampaignInput extends Partial<CreateCampaignInput> { revision: number }
export interface CampaignListFilters {
  status?: CampaignStatus[]; channel?: CampaignChannel; q?: string;
  sort?: '-created_at' | '-started_at'; page?: number; per_page?: number;
}
export interface ScheduleCampaignInput { scheduled_at: string }
/** POST /campaigns/{id}/test → 202 */
export interface CampaignTestResult { to_masked: string }

/** POST /campaigns/audience-preview (§3.3). Counts are an estimate; the snapshot at send start is authoritative. */
export interface AudiencePreviewInput { channel: CampaignChannel; audience: CampaignAudience }
export interface AudiencePreview {
  /** segment size before exclusions */
  matched: number;
  excluded: { risky: number; recent_orders: number; opted_out: number; no_address: number; not_eligible: number };
  recipients: number;
  /**
   * percent of `recipients`, one decimal. PHASE-8-8 §6.6: tiers per P88-4; tier `new` (no parcels) is counted in
   * `good` ("campaigns treat new like good"), so the shape keeps three keys.
   */
  risk_breakdown: Record<Exclude<RiskTier, 'new'>, number>;
}

export type SmsEncoding = 'gsm7' | 'ucs2';
export interface CampaignEstimateInput {
  channel: CampaignChannel; language: CampaignLanguage; body: string; subject?: string | null;
  audience: CampaignAudience; coupon_id?: string | null; product_id?: string | null;
}
/**
 * POST /campaigns/estimate. SMS: parts of the rendered sample (20-char sample name, prefix + footer included).
 * Email: `parts_per_recipient` 1, `total_parts` = emails, `encoding` null, `characters` = body length.
 */
export interface CampaignEstimate {
  recipients: number; parts_per_recipient: number; total_parts: number; encoding: SmsEncoding | null; characters: number;
  /** the channel's monthly allowance (`campaign_sms_per_month` parts / `campaign_emails_per_month`); null limit = unlimited */
  allowance: { limit: number | null; used: number; remaining: number | null; after: number | null };
}

export type CampaignRecipientStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'skipped' | 'unknown';
/** contract name */
export type RecipientStatus = CampaignRecipientStatus;
/** §4.3 send-time checks */
export type SkipReason =
  | 'opted_out' | 'customer_deleted' | 'address_changed' | 'not_eligible' | 'cancelled' | 'plan' | 'store_unavailable';
export type CampaignRecipientErrorCode = 'provider_error' | 'invalid_address';
export interface CampaignRecipient {
  id: string; customer: { id: string; name: string } | null;
  /** `+880 17•• •••123` / `n•••@gmail.com` — never the full address */
  masked_address: string;
  status: CampaignRecipientStatus; skip_reason: SkipReason | null; error_code: CampaignRecipientErrorCode | null;
  parts: number; sent_at: string | null; unsubscribed_at: string | null;
  attributed_order: { id: string; number: string; total_amount: number } | null;
}
export interface CampaignRecipientFilters {
  status?: CampaignRecipientStatus[]; skip_reason?: SkipReason[]; cursor?: string;
}

export type MarketingRange = '7d' | '30d' | '90d';
export interface MarketingOverview {
  range: MarketingRange;
  kpis: {
    /** P85-22: non-cancelled orders in range with a coupon redemption or a campaign conversion (each once) */
    revenue_amount: number;
    /** vs the previous range of the same length; null when the previous range had no revenue */
    revenue_change_pct: number | null;
    campaign_orders: number;
    /** percent of all orders in range, one decimal */
    campaign_orders_share_pct: number;
    /** campaign messages (SMS recipients + emails) sent in range */
    messages_sent: number;
    unsubscribes: number;
    /** Phase 8.6 (P86-15): `automation_conversions` in range (non-cancelled orders) */
    carts_recovered: number;
    /** Phase 8.6: revenue of those orders; also included in `revenue_amount` (each order once) */
    recovered_revenue_amount: number;
  };
  /**
   * 8 weeks, oldest first; `week_start` = ISO-week Monday (`YYYY-MM-DD`, store tz), as in reports.
   * Phase 8.6: `recovery_amount` = automation-conversion revenue that week ("Cart recovery" series).
   */
  series: { week_start: string; coupons_amount: number; campaigns_amount: number; recovery_amount: number }[];
  /** top 4 active coupons by revenue */
  active_coupons: {
    id: string; code: string; type: CouponType; percent_bps: number | null; amount: number | null;
    ends_at: string | null; used_count: number; usage_limit: number | null; revenue_amount: number;
  }[];
  /** latest 5 */
  recent_campaigns: CampaignListItem[];
  /** Phase 8.6: `automations` = automations with status `on` (Automations tab count) */
  counts: { coupons: number; campaigns: number; automations: number };
  currency: string;
}

// Consent + opt-out (§4)
export type SuppressionSource = 'link' | 'merchant' | 'import';
export type CustomerMarketingStatus = 'subscribed' | 'unsubscribed' | 'not_eligible' | 'no_address';
/**
 * `Customer.marketing` (§4.1, computed). `unsubscribed_source` is per channel (null when that channel is not suppressed):
 * `link` = by the customer (merchant can't remove), `merchant` = by you ("Allow again").
 */
export interface CustomerMarketing {
  sms: CustomerMarketingStatus; email: CustomerMarketingStatus;
  unsubscribed_sms_at: string | null; unsubscribed_email_at: string | null;
  unsubscribed_source: { sms: SuppressionSource | null; email: SuppressionSource | null };
}
export interface MarketingOptOutInput { channel: MarketingChannel }

/** Storefront GET/POST /storefront/unsubscribe/{code} (§4.2). */
export interface UnsubscribeStatus {
  channel: MarketingChannel;
  masked_address: string;
  status: 'subscribed' | 'unsubscribed';
  /** a test-send code: POST changes nothing */
  is_test: boolean;
  store_name: string;
}
export type UnsubscribeAction = 'unsubscribe' | 'resubscribe';
export interface UnsubscribeInput { action: UnsubscribeAction; one_click?: boolean }
/** `^[A-Za-z0-9]{10}$` */
export const UNSUBSCRIBE_CODE_PATTERN = /^[A-Za-z0-9]{10}$/;

/** GET /dev/stores/{store}/message-sink (non-production only, `CAMPAIGNS_DEV_SINK=true`; 404 otherwise). Newest first, ≤ 200. */
export interface DevSinkMessage {
  channel: MarketingChannel; to: string; subject: string | null;
  /** full rendered SMS text, or the email plain-text part */
  text: string;
  unsubscribe_url: string; campaign_id: string | null; is_test: boolean; created_at: string;
  /** Phase 8.6 (§8): set for automation messages (then `campaign_id` is null); null for campaign messages */
  automation_id: string | null;
}

/** Audit actions written by Phase 8.5 (§6.1). `AuditLog.action` stays `string`; this lists the new values. */
export type CampaignAuditAction =
  | 'campaign.created' | 'campaign.deleted' | 'campaign.test_sent' | 'campaign.scheduled' | 'campaign.sent'
  | 'campaign.unscheduled' | 'campaign.cancelled' | 'customer.marketing_opted_out' | 'customer.marketing_opt_out_removed';
export const CAMPAIGN_AUDIT_ACTIONS: readonly CampaignAuditAction[] = [
  'campaign.created', 'campaign.deleted', 'campaign.test_sent', 'campaign.scheduled', 'campaign.sent',
  'campaign.unscheduled', 'campaign.cancelled', 'customer.marketing_opted_out', 'customer.marketing_opt_out_removed',
];

// ---------- Phase 8.6: automations + checkout recovery (PHASE-8-6-CONTRACT §3–§9; openapi 1.14.0) ----------
/** P86-2: the fixed recipe catalogue, UI order. One automation per recipe per store (P86-1). */
export type RecipeKey = 'checkout_recovery' | 'thank_you' | 'vip_tag' | 'return_flag' | 'low_stock';
export const RECIPE_KEYS: readonly RecipeKey[] = ['checkout_recovery', 'thank_you', 'vip_tag', 'return_flag', 'low_stock'];
/** `draft → on ⇄ off`. Only a `draft` (never run) can be deleted. */
export type AutomationStatus = 'draft' | 'on' | 'off';
export const AUTOMATION_STATUSES: readonly AutomationStatus[] = ['draft', 'on', 'off'];
/** P86-17: `plan` = the store's plan lacks `sms_automation`; settings and toggle state are kept, no runs are created. */
export type AutomationPausedReason = 'plan';
/** §4.1 trigger keys (`AutomationRun.trigger`). */
export type AutomationTrigger = 'checkout.abandoned' | 'order.delivered' | 'return.received' | 'stock.low';
export const RECIPE_TRIGGERS: Readonly<Record<RecipeKey, AutomationTrigger>> = {
  checkout_recovery: 'checkout.abandoned',
  thank_you: 'order.delivered',
  vip_tag: 'order.delivered',
  return_flag: 'return.received',
  low_stock: 'stock.low',
};

/** §1/§8 limits the UI mirrors (server is authoritative). */
export const AUTOMATION_LIMITS = {
  name_max: 80,
  /** P86-7: SMS parts incl. the shop prefix and opt-out footer (campaigns allow 5) */
  sms_max_parts: 3,
  email_subject_max: 150,
  email_body_max: 3000,
  /** P86-9 quiet hours, store time, always on (not a merchant toggle) */
  quiet_hours: { from: '21:00', to: '09:00' },
  /** P86-10: automation marketing messages per (store, channel, address) per rolling 24 h, across automations */
  frequency_cap_per_24h: 2,
  /** §5 */
  max_conditions: 5,
  /** P86-22 test messages per user per hour */
  test_sends_per_hour: 5,
  /** §9.1 dry runs per user per minute */
  dry_runs_per_minute: 30,
  /** P86-6 / Q162 */
  run_retention_days: 90,
  conversion_retention_months: 13,
  /** P86-15/P86-11: recovery flow sends at most this many messages per run */
  recovery_max_messages: 2,
  tag_max: 40,
} as const;

/** §3 recipe parameters: defaults and bounds (server validates; WEB pre-fills). Durations are integers. */
export const RECIPE_PARAMS = {
  checkout_recovery: {
    delay_minutes: { default: 30, min: 15, max: 180, options: [15, 30, 60, 120, 180] },
    wait_hours: { default: 24, min: 6, max: 48 },
    exit_days: { default: 3, min: 1, max: 7 },
  },
  thank_you: { delay_hours: { default: 0, min: 0, max: 72 } },
  vip_tag: { min_delivered: { default: 5, min: 2, max: 50 }, tag: { default: 'VIP', min_length: 1, max_length: 40 } },
  return_flag: { tag: { default: 'Returned', min_length: 1, max_length: 40 } },
  low_stock: {},
} as const;

/** §8 merge fields per recipe. Anything else in `{…}` → 422 `campaign_unknown_merge_field`. */
export type AutomationMergeField = '{name}' | '{shop_link}' | '{coupon}' | '{product}' | '{cart_link}' | '{order_no}';
export const RECIPE_MERGE_FIELDS: Readonly<Record<RecipeKey, readonly AutomationMergeField[]>> = {
  checkout_recovery: ['{name}', '{cart_link}', '{product}', '{coupon}', '{shop_link}'],
  thank_you: ['{name}', '{order_no}', '{product}', '{shop_link}'],
  vip_tag: ['{name}', '{coupon}', '{shop_link}'],
  return_flag: [],
  low_stock: [],
};

/**
 * One customer message in `settings` (§3). `subject` is required for `email` (1–150, no CR/LF) and null for `sms`.
 * `body` never includes the automatic shop prefix / opt-out footer.
 */
export interface AutomationMessage {
  channel: MarketingChannel; language: CampaignLanguage; body: string; subject: string | null;
}

// Conditions (§5): fixed list, all must hold, ≤ 5.
export type AutomationConditionField =
  | 'order.total_amount' | 'order.payment_method' | 'order.channel' | 'customer.tag'
  | 'customer.delivered_orders_count' | 'customer.risk';
export type AutomationCondition =
  /** minor units ≥ 0 */
  | { field: 'order.total_amount'; op: 'gt' | 'lt'; value: number }
  | { field: 'order.payment_method'; op: 'is'; value: 'cod' | 'online' }
  /** non-empty subset of `OrderChannel` */
  | { field: 'order.channel'; op: 'in'; value: OrderChannel[] }
  /** 1–40 chars */
  | { field: 'customer.tag'; op: 'has' | 'not_has'; value: string }
  /** 2–50 */
  | { field: 'customer.delivered_orders_count'; op: 'gte'; value: number }
  /** PHASE-8-8 P88-3: evaluated with `RiskTier` (P88-4) */
  | { field: 'customer.risk'; op: 'is_not'; value: Extract<RiskTier, 'risky'> };
export type AutomationConditionOp = AutomationCondition['op'];
/** Conditions a recipe's `settings.conditions` may hold (only `thank_you` has a free list; see §11.1 C2). */
export const RECIPE_CONDITION_FIELDS: Readonly<Record<RecipeKey, readonly AutomationConditionField[]>> = {
  checkout_recovery: ['customer.risk'],
  thank_you: ['order.total_amount', 'order.payment_method', 'order.channel', 'customer.tag'],
  vip_tag: ['customer.delivered_orders_count'],
  return_flag: [],
  low_stock: [],
};
/** §5 "Order channel" chips → `OrderChannel` values (Messenger / POS hidden). */
export const AUTOMATION_ORDER_CHANNEL_CHIPS: readonly { label: string; channels: readonly OrderChannel[] }[] = [
  { label: 'Storefront', channels: ['website'] },
  { label: 'Landing pages', channels: ['landing_page'] },
  { label: 'Facebook', channels: ['facebook'] },
  { label: 'Instagram', channels: ['instagram'] },
  { label: 'Phone / manual', channels: ['phone', 'walk_in'] },
  { label: 'Other', channels: ['other'] },
];

// Settings per recipe (§3). `settings` is replaced as a whole on PATCH; unknown keys → 422.
export interface CheckoutRecoverySettings {
  /** idle minutes before a checkout counts as abandoned (15–180) */
  delay_minutes: number;
  step1: { enabled: boolean; message: AutomationMessage };
  /** wait between step 1 and step 2, "only if still no order" (6–48) */
  wait_hours: number;
  /** step 2 may carry a coupon (`{coupon}`); inactive at send time → step `skipped/coupon_inactive` */
  step2: { enabled: boolean; coupon_id: string | null; message: AutomationMessage };
  /** exit window (1–7) */
  exit_days: number;
  /** "Skip risky customers" → condition `customer.risk is_not risky` when the phone matches a customer */
  skip_risky: boolean;
}
export interface ThankYouSettings {
  /** 0 = send on delivery (0–72) */
  delay_hours: number;
  message: AutomationMessage;
  /** ≤ 5, fields from `RECIPE_CONDITION_FIELDS.thank_you` */
  conditions: AutomationCondition[];
}
export interface VipTagSettings {
  /** condition `customer.delivered_orders_count gte n` (2–50) */
  min_delivered: number;
  /** 1–40 */
  tag: string;
  /** optional message; when enabled the body must use `{coupon}` and `coupon_id` is required to enable */
  message: AutomationMessage & { enabled: boolean };
  coupon_id: string | null;
}
export interface ReturnFlagSettings { tag: string }
export type LowStockSettings = Record<string, never>;
export interface AutomationSettingsMap {
  checkout_recovery: CheckoutRecoverySettings;
  thank_you: ThankYouSettings;
  vip_tag: VipTagSettings;
  return_flag: ReturnFlagSettings;
  low_stock: LowStockSettings;
}
export type AutomationSettings = AutomationSettingsMap[RecipeKey];

/** `RecipeCard` (§9.2): the catalogue tile; `added` = the store already has this recipe. `icon` is a UI icon name. */
export interface RecipeCard {
  recipe: RecipeKey; name: string; description: string; trigger_label: string; action_label: string; icon: string;
  added: boolean;
}

/** One automation of recipe `R` (§9.2). */
export interface AutomationOf<R extends RecipeKey> {
  id: string; recipe: R; name: string; status: AutomationStatus; paused_reason: AutomationPausedReason | null;
  settings: AutomationSettingsMap[R];
  /** Figma tag texts, e.g. "Checkout left 30 min" → "Reminder SMS" */
  trigger_label: string; action_label: string;
  runs_7d: number; last_run_at: string | null; created_at: string; updated_at: string; revision: number;
}
/** Discriminated on `recipe`: `settings` narrows with it. */
export type Automation = { [R in RecipeKey]: AutomationOf<R> }[RecipeKey];

/** Step kinds in a recipe's fixed flow; `wait` never produces a step row. */
export type StepAction = 'send_message' | 'add_tag' | 'notify_team';
export type RecipeStepKind = StepAction | 'wait';
/** Editor schema summary (`AutomationDetail.recipe_schema`, §11.1 C3). */
export interface RecipeSchema {
  trigger: AutomationTrigger;
  /** "When" step copy */
  trigger_description: string;
  allowed_conditions: AutomationConditionField[];
  max_conditions: number;
  /** fixed order; `message_step` = 1|2 for `send_message` (test-message / settings key), else null */
  steps: { kind: RecipeStepKind; title: string; description: string; optional: boolean; message_step: 1 | 2 | null }[];
  merge_fields: AutomationMergeField[];
  sms_max_parts: number;
}
export interface AutomationStats7d { runs: number; completed: number; skipped: number; stopped: number; failed: number }
/** GET /automations/{id} */
export type AutomationDetail = Automation & {
  recipe_schema: RecipeSchema;
  stats_7d: AutomationStats7d;
  /** latest `automation.created|updated` audit actor; null when unknown (§11.1 C4) */
  last_edited_by: UserRef | null;
};

/** GET /automations `meta.kpis` (§9.1). Money in minor units of the store currency. */
export interface AutomationKpis {
  active: number; drafts: number; total: number;
  runs_7d: number;
  /** completed ÷ non-skipped runs in 7 days, percent, one decimal; null when there are none */
  runs_7d_succeeded_pct: number | null;
  /** automation message steps `done` this calendar month (store tz) */
  messages_sent_month: number;
  carts_recovered_30d: number;
  recovered_revenue_30d: number;
}
export interface AutomationListMeta { recipes: RecipeCard[]; kpis: AutomationKpis }

export interface CreateAutomationInput { recipe: RecipeKey }
/** PATCH: `revision` required (409 `revision_conflict`); `settings` replaces the whole object and is validated per recipe. */
export interface UpdateAutomationInput<R extends RecipeKey = RecipeKey> {
  name?: string; settings?: AutomationSettingsMap[R]; revision: number;
}

// Runs + steps (§4.2, §6)
export type RunStatus = 'running' | 'waiting' | 'completed' | 'skipped' | 'stopped' | 'failed';
export const RUN_STATUSES: readonly RunStatus[] = ['running', 'waiting', 'completed', 'skipped', 'stopped', 'failed'];
/**
 * `skipped`: `conditions_not_met` | `subject_missing` | `no_eligible_address` (first message had no eligible address);
 * `stopped`: `converted` | `window_ended` | `opted_out` | `automation_off` | `plan`; `failed`: `error`.
 */
export type RunOutcomeReason =
  | 'conditions_not_met' | 'subject_missing' | 'no_eligible_address'
  | 'converted' | 'window_ended' | 'opted_out' | 'automation_off' | 'plan'
  | 'error';
export type RunSubjectType = 'order' | 'cart' | 'return' | 'inventory';
export type StepStatus = 'sending' | 'done' | 'skipped' | 'failed' | 'unknown';
/** §6 skip reasons (`skipped`) and failure codes (`failed`). */
export type StepReason =
  | 'not_eligible' | 'no_address' | 'opted_out' | 'frequency_cap' | 'allowance' | 'coupon_inactive'
  | 'no_customer' | 'already_tagged' | 'tags_full' | 'no_recipients'
  | 'provider_error' | 'invalid_address';
/** Snapshot taken at trigger time (§4.2); keys present depend on the subject. Contact is never unmasked. */
export interface AutomationRunContext {
  order_number?: string; order_total_amount?: number;
  cart_line_count?: number; cart_total_amount?: number;
  /** first cart/order line */
  first_product_name?: string; first_product_image_url?: string | null;
  return_number?: string;
  product_name?: string; variant_name?: string | null; on_hand?: number;
  currency?: string;
}
export interface AutomationRunStepDetail {
  /** `notify_team`: number of recipients emailed */
  recipients?: number;
  /** `add_tag`: the tag */
  tag?: string;
  /** `send_message` with a coupon */
  coupon_code?: string;
  /** 1|2 for recovery message steps */
  message_step?: 1 | 2;
}
export interface AutomationRunStep {
  index: number; action: StepAction; status: StepStatus; reason: StepReason | null;
  channel: MarketingChannel | null;
  /** never the full address */
  masked_address: string | null;
  parts: number; detail: AutomationRunStepDetail | null; executed_at: string;
}
export interface AutomationRunOutcomeDetail {
  conditions: { field: string; label: string; passed: boolean; detail: string | null }[];
}
export interface AutomationRun {
  id: string;
  automation: { id: string; recipe: RecipeKey; name: string };
  trigger: AutomationTrigger; status: RunStatus; outcome_reason: RunOutcomeReason | null;
  /** Per-condition results when `outcome_reason` is `conditions_not_met` (contract §6 step 3); else null. */
  outcome_detail: AutomationRunOutcomeDetail | null;
  /** `label` e.g. "GS-1048", "Cart · 2 items" */
  subject: { type: RunSubjectType; id: string; label: string };
  /** null for runs without a person (low stock). `name` needs `customers.view` (else null, P86-18). */
  contact: { masked_address: string | null; name: string | null } | null;
  context: AutomationRunContext;
  steps: AutomationRunStep[];
  started_at: string; resume_at: string | null; finished_at: string | null;
  conversion: { order: { id: string; number: string; total_amount: number } } | null;
}
export interface AutomationRunFilters {
  automation_id?: string; recipe?: RecipeKey; status?: RunStatus[];
  /** ISO 8601 date-time */
  since?: string; cursor?: string;
}

// Dry run (P86-21) + test message (P86-22)
/** At most one id, matching the recipe's subject; none = the latest matching subject. */
export interface AutomationDryRunInput {
  order_id?: string; cart_id?: string; inventory_id?: string; return_id?: string;
}
export type DryRunWould = 'send' | 'skip' | 'tag' | 'notify';
export interface AutomationDryRun {
  /** the evaluated subject; null when the store has no matching subject (then both lists are empty) */
  subject: { type: RunSubjectType; id: string; label: string } | null;
  conditions: { label: string; passed: boolean; detail: string | null }[];
  steps: {
    index: number; action: StepAction; would: DryRunWould; reason: StepReason | null;
    rendered: { channel: MarketingChannel; subject: string | null; text: string; parts: number } | null;
  }[];
}
export interface AutomationTestMessageInput { step: 1 | 2 }
/** POST /automations/{id}/test-message → 202 */
export type AutomationTestResult = CampaignTestResult;

// Stats (recovery page, §7 / §9.1)
export type AutomationStatsDays = 14 | 30;
export interface AutomationStats {
  days: AutomationStatsDays;
  /** per message step over `days`: sent = steps `done`, recovered = conversions credited to it */
  steps: { step: number; sent: number; recovered: number; revenue_amount: number }[];
  /** `days` entries, oldest first, `YYYY-MM-DD` store tz */
  daily: { date: string; recovered: number; revenue_amount: number }[];
  /** always the last 30 days (§11.1 C6) */
  kpis: {
    /** runs created */
    carts_left_behind: number;
    /** sum of context cart totals */
    carts_left_behind_amount: number;
    recovered: number;
    /** conversions ÷ runs with ≥ 1 message done, percent, one decimal; null when none */
    recovery_rate_pct: number | null;
    revenue_amount: number;
    /** revenue ÷ recovered; null when none */
    average_recovered_amount: number | null;
    /** this calendar month */
    messages_sent_month: number;
  };
  currency: string;
}

// Storefront (§7)
/** PUT /storefront/cart/contact → 204. `phone` = valid BD mobile (normalized server-side). */
export interface CartContactInput { phone: string; name?: string | null; email?: string | null }
/** POST /storefront/carts/recover → 201 */
export interface RecoverCartInput { code: string }
export interface RecoverCartResult { cart_token: string; next: 'checkout' | 'cart' }
/** P86-16 `/r/{code}`: 10 base62 */
export const RECOVERY_CODE_PATTERN = /^[A-Za-z0-9]{10}$/;
/** §10.6 checkout notice under the phone field */
export const CHECKOUT_CONTACT_NOTICE = {
  en: "If you don't finish, we may text you a reminder. You can opt out any time.",
  bn: 'অর্ডার শেষ না করলে আমরা একটি রিমাইন্ডার SMS পাঠাতে পারি। যেকোনো সময় বন্ধ করতে পারবেন।',
} as const;

/** Audit actions written by Phase 8.6 (§4.4). */
export type AutomationAuditAction =
  | 'automation.created' | 'automation.updated' | 'automation.enabled' | 'automation.disabled'
  | 'automation.deleted' | 'automation.test_sent';
export const AUTOMATION_AUDIT_ACTIONS: readonly AutomationAuditAction[] = [
  'automation.created', 'automation.updated', 'automation.enabled', 'automation.disabled', 'automation.deleted',
  'automation.test_sent',
];

// ---------- Expenses (Phase 8.7, PHASE-8-7-CONTRACT §3–§8) ----------
/** §3: six fixed, code-defined categories (UI order). `ads` → P&L "Ad spend"; the rest → "Other expenses". */
export type ExpenseCategory = 'ads' | 'packaging' | 'salaries' | 'rent_bills' | 'courier' | 'other';
export const EXPENSE_CATEGORIES: readonly ExpenseCategory[] = ['ads', 'packaging', 'salaries', 'rent_bills', 'courier', 'other'];
/** §3 labels (UI copy; the API returns keys only). */
export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, { en: string; bn: string }> = {
  ads: { en: 'Ads', bn: 'বিজ্ঞাপন' },
  packaging: { en: 'Packaging', bn: 'প্যাকেজিং' },
  salaries: { en: 'Salaries', bn: 'বেতন' },
  rent_bills: { en: 'Rent & bills', bn: 'ভাড়া ও বিল' },
  courier: { en: 'Courier', bn: 'কুরিয়ার' },
  other: { en: 'Other', bn: 'অন্যান্য' },
};
/** §3 hint shown with the Courier category (QA asserts it). */
export const EXPENSE_COURIER_HINT =
  'Only charges not already on courier invoices — delivery and COD fees of delivered parcels are counted automatically.';
/** Q175: a label only, no balances. */
export type PaidFrom = 'cash' | 'bank' | 'card' | 'bkash' | 'nagad' | 'other';
export const PAID_FROM_OPTIONS: readonly PaidFrom[] = ['cash', 'bank', 'card', 'bkash', 'nagad', 'other'];
export const PAID_FROM_LABELS: Record<PaidFrom, string> = {
  cash: 'Cash', bank: 'Bank', card: 'Card', bkash: 'bKash', nagad: 'Nagad', other: 'Other',
};
/** §8.3 bounds: amount in minor units 1 … 1,000,000,000 (৳ 1 crore); note ≤ 200; `spent_on` 2020-01-01 … today (store tz). */
export const EXPENSE_AMOUNT_MAX = 1_000_000_000;
export const EXPENSE_NOTE_MAX = 200;
export const EXPENSE_MIN_DATE = '2020-01-01';
/** §5.1 receipts: sniffed server-side; WEB downscales photos whose long side > 2,560 px before upload (§10.1). */
export const EXPENSE_RECEIPT_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export type ExpenseReceiptMime = (typeof EXPENSE_RECEIPT_MIMES)[number];
export const EXPENSE_RECEIPT_MAX_BYTES = 5 * 1024 * 1024;
export const EXPENSE_RECEIPT_DOWNSCALE_PX = 2560;
/**
 * Receipts live in `media` with purpose `expense_receipt` (private disk). Not a library `MediaPurpose`: the generic
 * `/media` routes never accept, list or show it (§5.4).
 */
export type ExpenseReceiptPurpose = 'expense_receipt';

/** POST /stores/{store}/expenses/receipts → 201. Images are re-encoded (status `processing` → `ready`); PDFs `ready`. */
export interface ExpenseReceipt {
  id: string; mime: ExpenseReceiptMime; size_bytes: number; status: MediaStatus; created_at: string;
}
/** GET …/expenses/{expense}/receipt → signed 5-minute link; 409 `receipt_processing`, 403 `impersonation_receipt_hidden`. */
export interface ExpenseReceiptLink { url: string; mime: ExpenseReceiptMime; size_bytes: number; expires_at: string }

export interface Expense {
  id: string;
  category: ExpenseCategory;
  paid_from: PaidFrom;
  /** minor units, > 0 */
  amount: number;
  currency: string;
  /** `YYYY-MM-DD`, store-local calendar date */
  spent_on: string;
  note: string | null;
  receipt: { id: string; mime: ExpenseReceiptMime; size_bytes: number; status: MediaStatus } | null;
  /** true while the expense's recurrence is active */
  repeat_monthly: boolean;
  recurrence_id: string | null;
  /** null = generated by "Repeat every month" (or the member was removed) */
  created_by: { id: string; name: string } | null;
  created_at: string;
  updated_at: string;
}
/** POST body (first four required); PATCH = Partial. `currency` optional and must equal the store currency. */
export interface ExpenseInput {
  amount: number;
  category: ExpenseCategory;
  paid_from: PaidFrom;
  spent_on: string;
  note?: string | null;
  receipt_id?: string | null;
  repeat_monthly?: boolean;
  currency?: string;
}
export type UpdateExpenseInput = Partial<ExpenseInput>;
/** GET /expenses: `filter[month]` YYYY-MM (default current), `filter[category]` csv, cursor pages of 50. */
export interface ExpenseFilters { month?: string; category?: ExpenseCategory[]; cursor?: string }

export interface ExpenseCategoryTotal { category: ExpenseCategory; amount: number; count: number; share: number }
/** GET /expenses/summary?month= (§6.3). */
export interface ExpenseSummary {
  month: string;
  from: string;
  to: string;
  currency: string;
  total_amount: number;
  count: number;
  ads_amount: number;
  ads_share: number | null;
  by_category: ExpenseCategoryTotal[];
  /** P87-15: same day span of the previous month for the current month, full months otherwise. */
  compare: { label_month: string; total_amount: number; change_pct: number | null };
  delivered_orders_count: number;
  cost_per_order_amount: number | null;
  /** null without `reports.view` + `costs.view` or without plan `profit_reports` (P87-5). */
  profit_after_expenses_amount: number | null;
  /** newest first, ≤ 36 */
  months: string[];
}

/** Audit actions written by Phase 8.7 (§4); `expense.repeated` has actor type `system`. */
export type ExpenseAuditAction =
  | 'expense.created' | 'expense.updated' | 'expense.deleted' | 'expense.exported'
  | 'expense.recurrence_started' | 'expense.recurrence_stopped' | 'expense.repeated';
export const EXPENSE_AUDIT_ACTIONS: readonly ExpenseAuditAction[] = [
  'expense.created', 'expense.updated', 'expense.deleted', 'expense.exported', 'expense.recurrence_started',
  'expense.recurrence_stopped', 'expense.repeated',
];

// ---------- Fake-order guard (Phase 8.8a, PHASE-8-8-CONTRACT §3–§8; openapi 1.16.0) ----------
/**
 * P88-4 tier from the phone's **own-shop** record (this store's orders/shipments/returns only, never another shop or a
 * courier): total = 0 → `new`; total < `min_parcels` → `careful` if returned ≥ 1 else `good`; rate < `hold_below` →
 * `risky`; rate < `advance_below` → `careful`; else `good`. One tier everywhere (orders, customers, campaigns, automations).
 */
export type RiskTier = 'good' | 'careful' | 'risky' | 'new';
export const RISK_TIERS: readonly RiskTier[] = ['good', 'careful', 'risky', 'new'];
/** §6.5 `Customer.risk` and `OrderCustomerSummary.risk`. `rate` = whole percent delivered ÷ total (null when total 0). */
export interface CustomerRisk { tier: RiskTier; rate: number | null; delivered: number; total: number }

/** P88-2: hold flag on a `pending` order (no new order status). `checking` = placed, check not finished yet. */
export type GuardHold = 'call_first' | 'advance' | 'checking';
export const GUARD_HOLDS: readonly GuardHold[] = ['call_first', 'advance', 'checking'];
/** §4 `order_risk_checks.decision`; `skipped` = check without actions (manual / online-paid orders, guard off, no plan). */
export type GuardDecision = 'none' | 'hold' | 'advance' | 'skipped';
/** §5.4 reason codes (stored; WEB renders the text). */
export type GuardReason =
  | 'rate_below_hold' | 'rate_below_advance' | 'few_parcels' | 'new_number' | 'duplicate' | 'blocked_number'
  | 'no_gateway' | 'otp_unavailable';
export const GUARD_REASONS: readonly GuardReason[] = [
  'rate_below_hold', 'rate_below_advance', 'few_parcels', 'new_number', 'duplicate', 'blocked_number', 'no_gateway',
  'otp_unavailable',
];
/** P88-1 / P88-7: the only record source is this shop (no courier rows). */
export interface GuardRecordSource { key: 'shop'; delivered: number; total: number }
export interface GuardRecord { total: number; delivered: number; sources: GuardRecordSource[] }
/**
 * §6.5 `Order.guard` (list + detail). While `hold = 'checking'` the check hasn't run yet: `tier`, `rate`, `decision`,
 * `record` and `checked_at` are null and `reasons` is empty. After a check without actions `hold` is null and
 * `decision = 'skipped'` (badge + record only).
 */
export interface OrderGuard {
  hold: GuardHold | null;
  tier: RiskTier | null;
  rate: number | null;
  reasons: GuardReason[];
  decision: GuardDecision | null;
  record: GuardRecord | null;
  /** the advance link created by the guard (`decision = 'advance'`) */
  payment_link_id: string | null;
  checked_at: string | null;
}

/** §4 / §6.1 `GET|PATCH /stores/{store}/fraud-guard/settings`. PATCH is partial; changes apply to later checks only. */
export type GuardAdvanceExpiryMinutes = 120 | 360 | 1440 | 2880;
export type GuardDuplicateWindowHours = 6 | 12 | 24 | 48 | 72;
export interface FraudGuardSettings {
  enabled: boolean;
  hold_enabled: boolean;
  /** 1–100 (%) */
  hold_below: number;
  advance_enabled: boolean;
  /** 1–100 (%), ≥ `hold_below` */
  advance_below: number;
  advance_expiry_minutes: GuardAdvanceExpiryMinutes;
  advance_cancel_if_unpaid: boolean;
  otp_enabled: boolean;
  block_returners: boolean;
  /** 1–20 */
  block_after_returns: number;
  duplicates_enabled: boolean;
  duplicate_window_hours: GuardDuplicateWindowHours;
  daily_limit_enabled: boolean;
  /** 1–50 storefront COD orders per phone per store day */
  daily_limit: number;
  /** 1–20; below this many parcels there is no ratio verdict */
  min_parcels: number;
  updated_by: { id: string; name: string } | null;
  updated_at: string | null;
}
export type UpdateFraudGuardSettingsInput = Partial<Omit<FraudGuardSettings, 'updated_by' | 'updated_at'>>;
/** §4 defaults ("Reset to recommended") and §8.3 bounds. */
export const FRAUD_GUARD_DEFAULTS: Omit<FraudGuardSettings, 'updated_by' | 'updated_at'> = {
  enabled: true, hold_enabled: true, hold_below: 60, advance_enabled: true, advance_below: 75,
  advance_expiry_minutes: 1440, advance_cancel_if_unpaid: true, otp_enabled: true, block_returners: true,
  block_after_returns: 3, duplicates_enabled: true, duplicate_window_hours: 24, daily_limit_enabled: true, daily_limit: 3,
  min_parcels: 3,
};
export const FRAUD_GUARD_BOUNDS = {
  hold_below: { min: 1, max: 100 }, advance_below: { min: 1, max: 100 }, block_after_returns: { min: 1, max: 20 },
  daily_limit: { min: 1, max: 50 }, min_parcels: { min: 1, max: 20 },
  advance_expiry_minutes: [120, 360, 1440, 2880] as readonly GuardAdvanceExpiryMinutes[],
  duplicate_window_hours: [6, 12, 24, 48, 72] as readonly GuardDuplicateWindowHours[],
} as const;
/** §6.4 / §10.1: six built rules (courier record and VPN rules are hidden). */
export const FRAUD_GUARD_RULES_TOTAL = 6;
export const FRAUD_GUARD_NOTE_MAX = 200;

/** §8.2 blocklist entry. `phone` is null without `customers.view`; `phone_masked` always ("01712•••678"). */
export type BlockedNumberReason = 'manual' | 'repeat_returns';
export type BlockedNumberSource = 'staff' | 'auto';
export interface BlockedNumber {
  id: string;
  phone_masked: string;
  phone: string | null;
  customer: { id: string; name: string } | null;
  reason: BlockedNumberReason;
  note: string | null;
  source: BlockedNumberSource;
  /** own-shop returned parcels of this phone now ("n returns at your shop" for `repeat_returns`) */
  returned_count: number;
  /** null for `source = 'auto'` */
  created_by: { id: string; name: string; role_label: string } | null;
  created_at: string;
}
/** POST …/blocked-numbers → 201: the entry + open (not shipped, not cancelled) orders of that phone; nothing is cancelled. */
export interface BlockedNumberCreated extends BlockedNumber { open_orders_count: number }
export interface BlockNumberInput { phone: string; note?: string | null }
/** `q` = phone digits (suffix match), cursor pages of 50. */
export interface BlockedNumberFilters { q?: string; cursor?: string }

/** §6.3 `POST …/fraud-guard/check` → own-shop record of one phone (limiter `fraud-check` 30/min per user; audited). */
export interface NumberCheck {
  phone_masked: string;
  tier: RiskTier;
  rate: number | null;
  delivered: number;
  total: number;
  sources: GuardRecordSource[];
  blocked: boolean;
  /** `YYYY-MM-DD` (store tz) of the latest own-shop return, null if none */
  last_return_on: string | null;
}

/** §6.4 `GET …/fraud-guard/overview?month=YYYY-MM` (store tz; default current month). */
export interface FraudGuardOverview {
  month: string;
  rules_on: number;
  rules_total: number;
  orders_checked: number;
  stopped: { held: number; blocked: number; duplicates: number; limited: number };
  /** Σ paid guard advance links in the month (Q191 "Advance collected"), minor units */
  advance_collected_amount: number;
  currency: string;
  /** active blocklist entries now */
  blocked_count: number;
}

/** §4 `fraud_guard_events.type`. */
export type FraudGuardEventType =
  | 'held' | 'advance_asked' | 'advance_paid' | 'released' | 'duplicate' | 'blocked_checkout' | 'limit_reached'
  | 'auto_blocked' | 'otp_failed';
export const FRAUD_GUARD_EVENT_TYPES: readonly FraudGuardEventType[] = [
  'held', 'advance_asked', 'advance_paid', 'released', 'duplicate', 'blocked_checkout', 'limit_reached', 'auto_blocked',
  'otp_failed',
];
/** Decision log row (`GET …/fraud-guard/events`, cursor pages of 50, newest first). `detail` never holds a raw phone. */
export interface FraudGuardEvent {
  id: string;
  type: FraudGuardEventType;
  order: { id: string; number: string } | null;
  phone_masked: string;
  detail: Record<string, unknown>;
  created_at: string;
}
export interface FraudGuardEventFilters { type?: FraudGuardEventType[]; cursor?: string }

/** §7 storefront `POST /storefront/checkout/otp`. Same shape for blocked, known and unknown numbers (no oracle). */
export interface CheckoutOtpInput { phone: string }
export interface CheckoutOtpResponse { required: boolean; expires_at: string | null; resend_after_seconds: number }
export const CHECKOUT_OTP_LENGTH = 6;
/** §7 / §8.4 storefront checkout error codes added by 8.8a (all 422). */
export type FraudCheckoutErrorCode = 'otp_required' | 'otp_invalid' | 'cod_unavailable' | 'order_limit_reached';
/** `otp_invalid` `error.details` */
export interface OtpInvalidDetails { attempts_left: number }
/** §8.4 merchant error codes added by 8.8a (409). */
export type FraudGuardErrorCode = 'order_held' | 'order_not_held' | 'already_blocked';

/** §4 audit actions (`fraud.number_checked` meta: masked phone + tier only). */
export type FraudAuditAction =
  | 'fraud.settings_updated' | 'fraud.number_blocked' | 'fraud.number_unblocked' | 'fraud.hold_released'
  | 'fraud.number_checked';
export const FRAUD_AUDIT_ACTIONS: readonly FraudAuditAction[] = [
  'fraud.settings_updated', 'fraud.number_blocked', 'fraud.number_unblocked', 'fraud.hold_released', 'fraud.number_checked',
];

// ---------- Purchasing: suppliers + purchase orders (Phase 8.8b, PHASE-8-8B-CONTRACT §3–§8; openapi 1.17.0) ----------
/**
 * Money on purchasing resources is integer minor units in the store currency. Every money/cost field is `null` for an
 * actor without `purchasing.manage` (an `inventory.adjust`-only receiver, P88B-11); quantities are always present.
 */
export type PurchaseOrderStatus = 'draft' | 'ordered' | 'partially_received' | 'received' | 'closed' | 'cancelled';
export const PURCHASE_ORDER_STATUSES: readonly PurchaseOrderStatus[] = [
  'draft', 'ordered', 'partially_received', 'received', 'closed', 'cancelled',
];
/** "Open" = still expected: counts as incoming stock and in "On the way". */
export const OPEN_PURCHASE_ORDER_STATUSES: readonly PurchaseOrderStatus[] = ['ordered', 'partially_received'];
/** P88B-8 from payments linked to the PO vs its total (advances before receipt show progress). */
export type PurchasePaymentStatus = 'unpaid' | 'partially_paid' | 'paid' | 'overpaid';
export const PURCHASE_PAYMENT_STATUSES: readonly PurchasePaymentStatus[] = ['unpaid', 'partially_paid', 'paid', 'overpaid'];
export type SupplierPaymentMethod = 'cash' | 'bkash' | 'nagad' | 'bank' | 'card' | 'other';
export const SUPPLIER_PAYMENT_METHODS: readonly SupplierPaymentMethod[] = ['cash', 'bkash', 'nagad', 'bank', 'card', 'other'];
export const SUPPLIER_PAYMENT_METHOD_LABELS: Record<SupplierPaymentMethod, string> = {
  cash: 'Cash', bkash: 'bKash', nagad: 'Nagad', bank: 'Bank', card: 'Card', other: 'Other',
};
/** P88B-14 "Send to supplier" channel (`sent_via`). Email is hidden in 8.8b. */
export type PurchaseOrderSentVia = 'whatsapp' | 'pdf' | 'manual';

/** §3 / §8.3 bounds (QA and WEB Zod mirror these). */
export const SUPPLIER_NAME_MAX = 120;
export const SUPPLIER_CITY_MAX = 80;
export const SUPPLIER_SUPPLIES_MAX = 200;
export const SUPPLIER_ACCOUNT_MAX = 60;
export const SUPPLIER_NOTES_MAX = 500;
export const SUPPLIER_TERMS_DAYS_MAX = 180;
export const SUPPLIER_LEAD_TIME_DAYS_MAX = 180;
export const PURCHASE_ORDER_NOTES_MAX = 1000;
export const PURCHASE_ORDER_LINES_MAX = 200;
export const PURCHASE_LINE_QUANTITY_MAX = 100_000;
export const PURCHASE_UNIT_COST_MAX = 1_000_000_000;
export const SUPPLIER_PAYMENT_AMOUNT_MAX = 10_000_000_000;
export const SUPPLIER_PAYMENT_NOTE_MAX = 200;
export const SUPPLIER_PAYMENT_REFERENCE_MAX = 60;
export const PURCHASE_RECEIPT_NOTE_MAX = 500;
export const SUPPLIER_INVOICE_REF_MAX = 60;
export const PURCHASING_MIN_DATE = '2020-01-01';
/** Supplier invoice uploads (`POST …/purchasing/invoices`): same rules as expense receipts (P87, S176). */
export const PURCHASE_INVOICE_MIMES = EXPENSE_RECEIPT_MIMES;
export const PURCHASE_INVOICE_MAX_BYTES = EXPENSE_RECEIPT_MAX_BYTES;
/** Private media purpose; never a library `MediaPurpose` (never accepted, listed or shown by `/media`). */
export type PurchaseInvoicePurpose = 'purchase_invoice';

// ----- Suppliers (§4, §6.1) -----
/** List row (`GET …/suppliers`). Derived numbers are computed per request (§4). */
export interface Supplier {
  id: string;
  name: string;
  contact_name: string | null;
  /** normalised "8801XXXXXXXXX" */
  phone: string | null;
  city: string | null;
  /** "What they supply" */
  supplies: string | null;
  payment_terms_days: number | null;
  advance_percent: number | null;
  lead_time_days: number | null;
  pays_by_method: SupplierPaymentMethod | null;
  pays_by_account: string | null;
  notes: string | null;
  archived_at: string | null;
  /** distinct products of the variants on its POs */
  products_count: number;
  /** POs `ordered` + `partially_received` */
  open_pos_count: number;
  /** non-draft, non-cancelled POs */
  past_orders_count: number;
  currency: string;
  /** Q209: Σ received value of non-cancelled POs − Σ payments; negative = credit (advance). */
  owed_amount: number;
  /** Σ balance of overdue POs (P88B-9); 0 when none. */
  overdue_amount: number;
  /** earliest `due_on` among overdue POs (`YYYY-MM-DD`) */
  overdue_since: string | null;
  /** last PO creation date (store tz, `YYYY-MM-DD`) */
  last_order_on: string | null;
  /** any PO created or receipt recorded this calendar month (store tz) */
  active_this_month: boolean;
  created_by: UserRef | null;
  created_at: string;
  updated_at: string;
}
/** `GET …/suppliers/{supplier}`: + the last 5 POs (newest first) with delivery and payment status. */
export interface SupplierDetail extends Supplier { recent_purchase_orders: PurchaseOrder[] }
export interface SupplierInput {
  name: string;
  contact_name?: string | null;
  /** BD mobile (`PhoneRule::bdMobile`), stored normalised */
  phone?: string | null;
  city?: string | null;
  supplies?: string | null;
  payment_terms_days?: number | null;
  advance_percent?: number | null;
  lead_time_days?: number | null;
  pays_by_method?: SupplierPaymentMethod | null;
  pays_by_account?: string | null;
  notes?: string | null;
}
export type UpdateSupplierInput = Partial<SupplierInput>;
export type SupplierSort = 'name' | '-owed_amount' | '-last_order_on';
/** `q` matches name, phone or city; `archived` false (default) = active only; 50 per page; default sort `name`. */
export interface SupplierListFilters { q?: string; archived?: boolean; sort?: SupplierSort; page?: number; per_page?: number }
export interface SupplierListMeta extends PaginationMeta { counts: { active: number; archived: number } }
/** `GET …/suppliers/summary` (§6.1). "Bought this month" = received value by receipt date (store tz); no comparison (Q211). */
export interface SupplierSummary {
  currency: string;
  suppliers_count: number;
  active_this_month: number;
  owed_amount: number;
  owed_suppliers_count: number;
  overdue_count: number;
  pos_on_the_way: number;
  arriving_this_week: number;
  bought_this_month_amount: number;
}

// ----- Purchase orders (§5) -----
export interface PurchaseOrderSupplierRef { id: string; name: string; phone: string | null; city: string | null }
/** Up to 2 thumbnails for the list "items" cell. */
export interface PurchaseOrderPreviewItem { product_name: string; image: MediaRef | null }
/** List item (`GET …/purchase-orders`). */
export interface PurchaseOrder {
  id: string;
  /** "PO-0012" (per-store sequence, P88B-3) */
  number: string;
  status: PurchaseOrderStatus;
  /** null for adjust-only actors */
  payment_status: PurchasePaymentStatus | null;
  supplier: PurchaseOrderSupplierRef;
  /** Phase 8.8c (P88C-8) "Receive at": where receipts stock (default location unless chosen; locked once received). */
  location: LocationRef;
  lines_count: number;
  preview_items: PurchaseOrderPreviewItem[];
  units_ordered: number;
  units_received: number;
  units_damaged: number;
  /** Σ left (ordered − received − damaged); 0 once received/closed/cancelled */
  units_left: number;
  /** `YYYY-MM-DD` */
  expected_on: string | null;
  /** expected_on < today (store tz) and status `ordered` / `partially_received` */
  is_late: boolean;
  days_late: number | null;
  ordered_at: string | null;
  sent_at: string | null;
  sent_via: PurchaseOrderSentVia | null;
  closed_at: string | null;
  cancelled_at: string | null;
  /** P88B-9: first receipt date + supplier terms (null terms → due on receipt) */
  due_on: string | null;
  is_overdue: boolean;
  currency: string;
  subtotal_amount: number | null;
  shipping_amount: number | null;
  discount_amount: number | null;
  total_amount: number | null;
  received_value_amount: number | null;
  paid_amount: number | null;
  /** received value − paid (negative = advance/credit) */
  balance_amount: number | null;
  revision: number;
  created_by: UserRef | null;
  created_at: string;
  updated_at: string;
}
export interface PurchaseOrderLine {
  id: string;
  variant_id: string;
  product: { id: string; name: string; image: MediaRef | null };
  variant_title: string;
  option_values: string[];
  sku: string | null;
  unit_cost_amount: number | null;
  quantity_ordered: number;
  quantity_received: number;
  quantity_damaged: number;
  /** ordered − received − damaged (Q213), never negative */
  quantity_left: number;
  /** unit cost × ordered */
  line_total_amount: number | null;
  /** current landed unit cost from the PO's present transport/discount (§5.4); what the next receipt would use */
  landed_unit_cost_amount: number | null;
  /** current on hand of the variant ("IN STOCK") */
  in_stock: number;
  /** "Last bought at": last PO unit cost for the variant from any supplier (excluding this PO) */
  last_bought_unit_cost_amount: number | null;
  position: number;
}
export interface PurchaseReceiptLine {
  item_id: string;
  variant_id: string;
  quantity_received: number;
  quantity_damaged: number;
  landed_unit_cost_amount: number | null;
  cost_before_amount: number | null;
  cost_after_amount: number | null;
  on_hand_before: number;
}
/** Attached supplier invoice. `url` = signed 5-minute link (null while processing or in an impersonation session). */
export interface PurchaseInvoiceAttachment {
  id: string; mime: ExpenseReceiptMime; size_bytes: number; status: MediaStatus; url: string | null;
}
export interface PurchaseReceipt {
  id: string;
  received_at: string;
  received_by: UserRef | null;
  /** Phase 8.8c: the location this receipt stocked (the PO's location at the time). */
  location: LocationRef;
  supplier_invoice_ref: string | null;
  invoice: PurchaseInvoiceAttachment | null;
  note: string | null;
  units_received: number;
  units_damaged: number;
  /** Σ received × landed unit cost (damaged excluded) */
  value_amount: number | null;
  lines: PurchaseReceiptLine[];
}
export interface SupplierPayment {
  id: string;
  supplier: { id: string; name: string };
  purchase_order: { id: string; number: string } | null;
  amount: number;
  currency: string;
  method: SupplierPaymentMethod;
  /** `YYYY-MM-DD` */
  paid_on: string;
  reference: string | null;
  note: string | null;
  created_by: UserRef | null;
  created_at: string;
}
/** History rows on the PO detail (no "Approved by", P88B-7). */
export type PurchaseOrderEventType =
  | 'created' | 'updated' | 'sent' | 'marked_ordered' | 'received' | 'quick_received' | 'payment_recorded'
  | 'payment_deleted' | 'closed' | 'cancelled';
export interface PurchaseOrderEvent {
  type: PurchaseOrderEventType;
  actor: UserRef | null;
  created_at: string;
  sent_via: PurchaseOrderSentVia | null;
  /** receipts: units received / damaged */
  units: number | null;
  damaged: number | null;
  /** payments (null for adjust-only actors) */
  amount: number | null;
}
/** Supplier block on the PO detail and New PO card. */
export interface PurchaseOrderSupplier extends PurchaseOrderSupplierRef {
  contact_name: string | null;
  lead_time_days: number | null;
  payment_terms_days: number | null;
  advance_percent: number | null;
  pays_by_method: SupplierPaymentMethod | null;
  pays_by_account: string | null;
  past_orders_count: number;
  archived_at: string | null;
  /** null for adjust-only actors */
  owed_amount: number | null;
}
/** `GET …/purchase-orders/{po}`; also the 201 body of create, quick and receipts and the 200 body of PATCH/transitions. */
export interface PurchaseOrderDetail extends Omit<PurchaseOrder, 'supplier'> {
  supplier: PurchaseOrderSupplier;
  notes: string | null;
  lines: PurchaseOrderLine[];
  /** newest first */
  receipts: PurchaseReceipt[];
  /** empty for adjust-only actors; newest first */
  payments: SupplierPayment[];
  /** oldest first */
  events: PurchaseOrderEvent[];
}
export type PurchaseOrderStatusCounts = Record<PurchaseOrderStatus | 'all', number>;
export interface PurchaseOrderListMeta extends PaginationMeta { counts: PurchaseOrderStatusCounts }
/** `filter[status]` csv, `filter[supplier_id]`, `q` (PO number or supplier name); newest first; 25 per page. */
export interface PurchaseOrderListFilters {
  status?: PurchaseOrderStatus[]; supplier_id?: string; q?: string; page?: number; per_page?: number;
}
/** `GET …/purchase-orders/summary` (§6.2). */
export interface PurchaseOrderSummary {
  currency: string;
  open_count: number;
  open_total_amount: number;
  units_coming: number;
  suppliers_coming: number;
  owed_amount: number;
  /** POs with `due_on` in the next 7 days and a balance > 0 */
  payments_due_this_week: number;
  late_count: number;
  /** the most overdue late PO */
  first_late: { id: string; number: string; days_late: number } | null;
}

// ----- Inputs -----
export interface PurchaseOrderLineInput {
  variant_id: string;
  /** omitted on create → last unit cost from this supplier, else the variant's `cost_amount`, else 0 (§5.1) */
  unit_cost_amount?: number;
  quantity: number;
}
/** POST …/purchase-orders → 201 draft. Totals are always recomputed server-side; currency is the store's. */
export interface CreatePurchaseOrderInput {
  supplier_id: string;
  lines: PurchaseOrderLineInput[];
  /** Phase 8.8c "Receive at": omitted = default location; must be active; changing it after a receipt → 422 `location_locked`. */
  location_id?: string;
  expected_on?: string | null;
  shipping_amount?: number;
  discount_amount?: number;
  notes?: string | null;
}
/**
 * PATCH (`draft` / `ordered` only). `lines` replaces the whole set, matched by `variant_id`; a line with received or
 * damaged units can't be removed or drop below received + damaged (422). `supplier_id` only while `draft`.
 */
export interface UpdatePurchaseOrderInput extends Partial<CreatePurchaseOrderInput> { revision: number }
/** Transitions accept an optional `revision` (checked when sent → 409 `revision_conflict`). */
export interface PurchaseOrderTransitionInput { revision?: number }
export interface SendPurchaseOrderInput extends PurchaseOrderTransitionInput { sent_via: PurchaseOrderSentVia }
export interface ReceiveLineInput { item_id: string; received: number; damaged: number }
/** POST …/{po}/receipts (Idempotency-Key). Lines omitted or 0/0 are untouched; at least one quantity > 0. */
export interface ReceivePurchaseOrderInput {
  lines: ReceiveLineInput[];
  supplier_invoice_ref?: string | null;
  invoice_media_id?: string | null;
  note?: string | null;
}
export interface SupplierPaymentInput {
  amount: number;
  method: SupplierPaymentMethod;
  paid_on: string;
  /** the PO must belong to this supplier (422) */
  purchase_order_id?: string | null;
  reference?: string | null;
  note?: string | null;
  /** optional; must equal the store currency */
  currency?: string;
}
/** `quantity` = pieces delivered (ordered = quantity); `damaged` ≤ quantity; received = quantity − damaged. */
export interface QuickPurchaseLineInput { variant_id: string; unit_cost_amount: number; quantity: number; damaged?: number }
/** POST …/purchase-orders/quick (Idempotency-Key) → 201 `PurchaseOrderDetail` with status `received` (P88B-13). */
export interface QuickPurchaseInput {
  supplier_id: string;
  lines: QuickPurchaseLineInput[];
  /** Phase 8.8c: omitted = default location. */
  location_id?: string;
  shipping_amount?: number;
  discount_amount?: number;
  payment?: Omit<SupplierPaymentInput, 'purchase_order_id'> | null;
  supplier_invoice_ref?: string | null;
  invoice_media_id?: string | null;
  notes?: string | null;
}
/** POST …/purchasing/invoices → 201. Images re-encoded (`processing` → `ready`); PDFs `ready`. */
export interface PurchaseInvoice { id: string; mime: ExpenseReceiptMime; size_bytes: number; status: MediaStatus; created_at: string }

// ----- Reorder suggestions (§7) -----
export interface ReorderSuggestionItem {
  variant_id: string;
  product: { id: string; name: string; image: MediaRef | null };
  variant_title: string;
  sku: string | null;
  /** on_hand − committed */
  available: number;
  incoming: number;
  /** units shipped in the last 30 days */
  sold_30d: number;
  /** floor((available + incoming) ÷ daily); ≤ 0 → "Out of stock" */
  days_left: number;
  suggested_quantity: number;
  /** last PO unit cost for the variant from its last supplier; null when never bought */
  last_unit_cost_amount: number | null;
}
/** One group per last supplier (`supplier` null = "No supplier yet"); items sorted by `days_left`; ≤ 50 items in all. */
export interface ReorderSuggestionGroup {
  supplier: { id: string; name: string; lead_time_days: number | null } | null;
  items: ReorderSuggestionItem[];
}

/** §8.4 error codes added by 8.8b (`invalid_state_transition`, `revision_conflict`, `feature_not_in_plan` already exist). */
export type PurchasingErrorCode = 'over_receive' | 'variant_not_tracked' | 'supplier_in_use';

/** P88B-18 audit actions. */
export type PurchasingAuditAction =
  | 'purchasing.supplier_created' | 'purchasing.supplier_updated' | 'purchasing.supplier_archived'
  | 'purchasing.supplier_unarchived' | 'purchasing.supplier_deleted'
  | 'purchasing.purchase_order_created' | 'purchasing.purchase_order_updated' | 'purchasing.purchase_order_sent'
  | 'purchasing.purchase_order_marked_ordered' | 'purchasing.purchase_order_closed' | 'purchasing.purchase_order_cancelled'
  | 'purchasing.purchase_order_deleted' | 'purchasing.receipt_recorded' | 'purchasing.quick_received'
  | 'purchasing.payment_recorded' | 'purchasing.payment_deleted' | 'purchasing.suppliers_imported';
export const PURCHASING_AUDIT_ACTIONS: readonly PurchasingAuditAction[] = [
  'purchasing.supplier_created', 'purchasing.supplier_updated', 'purchasing.supplier_archived',
  'purchasing.supplier_unarchived', 'purchasing.supplier_deleted', 'purchasing.purchase_order_created',
  'purchasing.purchase_order_updated', 'purchasing.purchase_order_sent', 'purchasing.purchase_order_marked_ordered',
  'purchasing.purchase_order_closed', 'purchasing.purchase_order_cancelled', 'purchasing.purchase_order_deleted',
  'purchasing.receipt_recorded', 'purchasing.quick_received', 'purchasing.payment_recorded', 'purchasing.payment_deleted',
  'purchasing.suppliers_imported',
];

// ---------- Stock transfers + stock counts (Phase 8.8c part B, PHASE-8-8C-CONTRACT §3.2, §7–§9; openapi 1.19.0) ----------
/**
 * Compact variant reference on transfer and count lines (same fields as `PurchaseOrderLine`'s product/variant block).
 * `barcode` lets the count screen show what a scan matched.
 */
export interface StockVariantRef {
  /** variant id */
  id: string;
  product: { id: string; name: string; image: MediaRef | null };
  /** "Default" for single-variant products */
  title: string;
  option_values: string[];
  sku: string | null;
  barcode: string | null;
}

// ----- Transfers (§7, P88C-9 / P88C-10) -----
export type StockTransferStatus = 'draft' | 'in_transit' | 'received' | 'cancelled';
export const STOCK_TRANSFER_STATUSES: readonly StockTransferStatus[] = ['draft', 'in_transit', 'received', 'cancelled'];
/** "Open" = blocks archiving either location (P88C-17 reason `open_transfers`). */
export const OPEN_STOCK_TRANSFER_STATUSES: readonly StockTransferStatus[] = ['draft', 'in_transit'];
/** Pill text; a received transfer with `units_short > 0` shows "Received · n short" (danger). */
export const STOCK_TRANSFER_STATUS_LABELS: Record<StockTransferStatus, string> = {
  draft: 'Draft', in_transit: 'In transit', received: 'Received', cancelled: 'Cancelled',
};
/** §3.2 bounds (WEB Zod mirrors these). */
export const STOCK_TRANSFER_NOTE_MAX = 500;
export const STOCK_TRANSFER_LINES_MAX = 200;
export const STOCK_TRANSFER_QUANTITY_MAX = 100_000;

/** List item (`GET …/stock-transfers`); newest first. */
export interface StockTransfer {
  id: string;
  /** "TR-021" (per-store sequence, 3-digit padded) */
  number: string;
  status: StockTransferStatus;
  from_location: LocationRef;
  to_location: LocationRef;
  note: string | null;
  items_count: number;
  /** Σ line quantity (what leaves the source on send) */
  units_sent: number;
  /** Σ received; null until the transfer is received */
  units_received: number | null;
  /** Σ (quantity − received) written off at receive; 0 otherwise */
  units_short: number;
  created_by: UserRef | null;
  sent_at: string | null;
  received_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
}
export interface StockTransferLine {
  id: string;
  variant: StockVariantRef;
  quantity: number;
  /** null until received */
  quantity_received: number | null;
  /** current numbers of the variant at the **source** location (panel: "{From} stock a → b") */
  source_on_hand: number;
  /** on_hand − committed at the source */
  source_available: number;
  /** source row threshold (null = store default / none); the panel turns "a → b" red when b is at or below it */
  source_low_stock_threshold: number | null;
  position: number;
}
export type StockTransferEventType = 'created' | 'sent' | 'received' | 'cancelled';
export interface StockTransferEvent { type: StockTransferEventType; actor: UserRef | null; created_at: string }
/** `GET …/stock-transfers/{transfer}`; also the body of create (201), PATCH, send, receive and cancel. */
export interface StockTransferDetail extends StockTransfer {
  lines: StockTransferLine[];
  /** oldest first */
  events: StockTransferEvent[];
}
export type StockTransferStatusCounts = Record<StockTransferStatus | 'all', number>;
export interface StockTransferListMeta extends PaginationMeta { counts: StockTransferStatusCounts }
/** `filter[status]` csv, `filter[location_id]` (from **or** to), `q` (number); 25 per page. */
export interface StockTransferListFilters {
  status?: StockTransferStatus[]; location_id?: string; q?: string; page?: number; per_page?: number;
}
/** `GET …/stock-transfers/summary` (KPI tiles). "This month" = store timezone calendar month. */
export interface StockTransferSummary {
  drafts_count: number;
  in_transit_count: number;
  in_transit_units: number;
  last_sent_at: string | null;
  received_this_month_count: number;
  received_this_month_units: number;
  /** non-archived locations */
  locations: { count: number; names: string[] };
}
export interface StockTransferLineInput { variant_id: string; quantity: number }
/**
 * POST …/stock-transfers → 201 draft (plan `multi_warehouse`). `send: true` = create and send in one call (send rules
 * P88C-10 apply; pass an `Idempotency-Key`). Tracked variants only; one line per variant; 1–200 lines.
 */
export interface CreateStockTransferInput {
  from_location_id: string;
  to_location_id: string;
  note?: string | null;
  lines: StockTransferLineInput[];
  send?: boolean;
}
/** PATCH (`draft` only; plan `multi_warehouse`). `lines` replaces the whole set. Stale `revision` → 409 `revision_conflict`. */
export interface UpdateStockTransferInput extends Partial<Omit<CreateStockTransferInput, 'send'>> { revision: number }
/** send / cancel body: optional `revision` (checked when sent). */
export interface StockTransferTransitionInput { revision?: number }
export interface ReceiveStockTransferLineInput { item_id: string; received: number }
/**
 * POST …/{transfer}/receive (`in_transit` only; Idempotency-Key). One entry per line, 0 ≤ received ≤ quantity; the rest
 * is recorded as short (written off). "Receive all" = client shortcut (`received = quantity` for every line).
 */
export interface ReceiveStockTransferInput extends StockTransferTransitionInput { lines: ReceiveStockTransferLineInput[] }

/** `error.details` of 422 `insufficient_stock` on send (P88C-10): every line over the source's available. */
export interface InsufficientStockDetails { lines: { variant_id: string; requested: number; available: number }[] }
/** §9 error codes used by transfers (all pre-existing codes). */
export type StockTransferErrorCode =
  | 'insufficient_stock' | 'invalid_state_transition' | 'revision_conflict' | 'feature_not_in_plan' | 'location_archived';
/** P88C-18 audit actions (transfers). */
export type StockTransferAuditAction =
  | 'stock_transfer.created' | 'stock_transfer.updated' | 'stock_transfer.sent' | 'stock_transfer.received'
  | 'stock_transfer.cancelled' | 'stock_transfer.deleted';
export const STOCK_TRANSFER_AUDIT_ACTIONS: readonly StockTransferAuditAction[] = [
  'stock_transfer.created', 'stock_transfer.updated', 'stock_transfer.sent', 'stock_transfer.received',
  'stock_transfer.cancelled', 'stock_transfer.deleted',
];

// ----- Stock counts (§8, P88C-11 / P88C-12) -----
export type StockCountStatus = 'in_progress' | 'completed' | 'cancelled';
export const STOCK_COUNT_STATUSES: readonly StockCountStatus[] = ['in_progress', 'completed', 'cancelled'];
export const STOCK_COUNT_STATUS_LABELS: Record<StockCountStatus, string> = {
  in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled',
};
/** Line filter chips: Not counted / Differences / Matched (All = omitted). */
export type StockCountLineState = 'not_counted' | 'differences' | 'matched';
export const STOCK_COUNT_LINE_STATES: readonly StockCountLineState[] = ['not_counted', 'differences', 'matched'];
/** §3.2 / §8 bounds (WEB Zod mirrors these). */
export const STOCK_COUNT_NAME_MAX = 80;
export const STOCK_COUNT_LINES_MAX = 5_000;
export const STOCK_COUNT_COUNTED_MAX = 1_000_000;
export const STOCK_COUNT_CODE_MAX = 64;
export const STOCK_COUNT_LINES_PER_PAGE = 100;

/** List item (`GET …/stock-counts`, latest first) and the header of the detail. */
export interface StockCount {
  id: string;
  /** default "Count {d M} · {location}" */
  name: string;
  location: LocationRef;
  category: { id: string; name: string } | null;
  status: StockCountStatus;
  lines_count: number;
  /** progress = counted_count / lines_count */
  counted_count: number;
  currency: string;
  /** Σ value of differences (negative = stock loss); null without `costs.view` */
  net_value_amount: number | null;
  /** the "Set uncounted items to 0" choice; null until finished */
  zero_uncounted: boolean | null;
  started_by: UserRef | null;
  started_at: string;
  finished_by: UserRef | null;
  finished_at: string | null;
  cancelled_at: string | null;
  revision: number;
}
/**
 * "If you finish now" (P88C-12). Units are from counted lines (difference = counted − expected); every `*_amount` is
 * `difference × variant cost_amount` and null without `costs.view`. `net_value_amount` = extra − short value.
 */
export interface StockCountSummary {
  short_units: number;
  short_value_amount: number | null;
  extra_units: number;
  extra_value_amount: number | null;
  not_counted: number;
  matched: number;
  differences: number;
  net_value_amount: number | null;
}
/** `GET …/stock-counts/{count}`; also the body of start (201), finish and cancel. Lines come from `…/lines`. */
export interface StockCountDetail extends StockCount { summary: StockCountSummary }
export interface StockCountLine {
  id: string;
  variant: StockVariantRef;
  /** null = not counted yet */
  counted: number | null;
  /** location on_hand stored when the line was (last) counted; null while not counted */
  expected: number | null;
  /** counted − expected; null while not counted */
  difference: number | null;
  /** current on hand at the count's location (EXPECTED column for lines not counted yet) */
  on_hand: number;
  /** difference × cost; null while not counted or without `costs.view` */
  value_amount: number | null;
  counted_at: string | null;
  counted_by: UserRef | null;
  /** delta applied at finish (null before finish, or when nothing was applied) */
  applied_delta: number | null;
}
export type StockCountLineStateCounts = Record<StockCountLineState | 'all', number>;
export interface StockCountLineListMeta extends PaginationMeta { counts: StockCountLineStateCounts }
/** `GET …/stock-counts/{count}/lines`: `filter[state]`, `q` (product name, SKU or barcode); 100 per page. */
export interface StockCountLineFilters { state?: StockCountLineState; q?: string; page?: number; per_page?: number }
export type StockCountStatusCounts = Record<StockCountStatus | 'all', number>;
export interface StockCountListMeta extends PaginationMeta { counts: StockCountStatusCounts }
/** `filter[status]` csv, `filter[location_id]`; latest first; 25 per page. */
export interface StockCountListFilters {
  status?: StockCountStatus[]; location_id?: string; page?: number; per_page?: number;
}
/** POST …/stock-counts → 201. No plan gate. 409 `count_in_progress`; 422 `count_too_large` (> 5,000 lines). */
export interface StartStockCountInput { location_id: string; name?: string | null; category_id?: string | null }
/** POST …/{count}/scan: SKU then barcode, case-insensitive, within the count; +1. Unknown → 404 `count_line_not_found`. */
export interface ScanStockCountInput { code: string }
/**
 * PUT …/{count}/lines/{line}: `counted` 0–1,000,000, `null` = un-count. `revision` = the count's revision (optional;
 * stale → 409 `revision_conflict`). Every scan/set bumps the count's revision.
 */
export interface SetStockCountLineInput { counted: number | null; revision?: number }
/** Body of scan and set-line: the changed line, the fresh summary and the count header (progress, revision). */
export interface StockCountLineResult { line: StockCountLine; summary: StockCountSummary; count: StockCount }
/** POST …/{count}/finish (Idempotency-Key) → `completed`; uncounted lines keep stock unless `zero_uncounted`. */
export interface FinishStockCountInput { zero_uncounted: boolean; revision?: number }
/** POST …/{count}/cancel → `cancelled`; no stock change. */
export interface StockCountTransitionInput { revision?: number }

/** `error.details` of 409 `count_in_progress`: the location's open count. */
export interface CountInProgressDetails { count_id: string }
/** `error.details` of 422 `count_too_large`. */
export interface CountTooLargeDetails { lines: number; max: number }
/** `error.details` of 404 `count_line_not_found`: the code as sent. */
export interface CountLineNotFoundDetails { code: string }
/** §9 error codes added by 8.8c part B (+ existing `invalid_state_transition`, `revision_conflict`). */
export type StockCountErrorCode =
  | 'count_in_progress' | 'count_too_large' | 'count_line_not_found' | 'invalid_state_transition' | 'revision_conflict'
  | 'location_archived';
/** P88C-18 audit actions (counts). */
export type StockCountAuditAction = 'stock_count.started' | 'stock_count.finished' | 'stock_count.cancelled';
export const STOCK_COUNT_AUDIT_ACTIONS: readonly StockCountAuditAction[] = [
  'stock_count.started', 'stock_count.finished', 'stock_count.cancelled',
];
