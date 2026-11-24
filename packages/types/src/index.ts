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
  region: { country: string; currency: string; timezone: string };
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
  | 'custom_roles' | 'multi_warehouse' | 'pos' | 'profit_reports' | 'api_webhooks';
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
  | 'orders.view' | 'orders.process' | 'orders.refund' | 'shipments.manage' | 'shipments.cancel'
  | 'products.edit' | 'products.delete' | 'inventory.adjust' | 'customers.view' | 'customers.edit' | 'customers.delete'
  | 'costs.view' | 'reports.view' | 'data.export' | 'data.import' | 'marketing.manage' | 'settings.manage'
  | 'integrations.manage' | 'domains.manage' | 'developers.manage' | 'staff.manage' | 'audit.view' | 'billing.view'
  | 'billing.manage';
export type PermissionGroupKey = 'orders' | 'shipping' | 'products' | 'customers' | 'money' | 'store' | 'team';

/**
 * §2.1 order (UI order); `billing.manage` last (owner only, never grantable). Phase 8.4 (PHASE-8-4 §2.1):
 * `developers.manage` (group `store`, sensitive) after `domains.manage`; owner + admin, never staff.
 */
export const PERMISSION_KEYS: readonly PermissionKey[] = [
  'orders.view', 'orders.process', 'orders.refund', 'shipments.manage', 'shipments.cancel',
  'products.edit', 'products.delete', 'inventory.adjust', 'customers.view', 'customers.edit', 'customers.delete',
  'costs.view', 'reports.view', 'data.export', 'data.import', 'marketing.manage', 'settings.manage',
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
export interface InventoryLevel {
  on_hand: number; committed: number; available: number;
  low_stock_threshold: number | null; effective_threshold: number; status: StockStatus;
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

// ---------- Inventory ----------
export interface InventoryItem {
  variant_id: string;
  product: { id: string; name: string; status: ProductStatus; image: MediaRef | null };
  title: string; option_values: string[]; sku: string | null; barcode: string | null;
  on_hand: number; committed: number; available: number;
  low_stock_threshold: number | null; effective_threshold: number; status: StockStatus;
  track_inventory: boolean; price_amount: number; cost_amount: number | null; updated_at: string;
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
  sort?: 'name' | 'available' | '-available' | '-updated_at'; page?: number; per_page?: number;
}
export type StockMovementReason = 'initial' | 'received' | 'correction' | 'damaged' | 'lost' | 'returned' | 'import' | 'other' | 'order_shipped' | 'order_returned';
export type ManualStockReason = Exclude<StockMovementReason, 'initial' | 'import' | 'order_shipped' | 'order_returned'>;
export interface StockAdjustmentItem { variant_id: string; mode: 'delta' | 'set'; quantity: number; expected_on_hand?: number }
export interface StockAdjustmentInput { reason: ManualStockReason; note?: string | null; items: StockAdjustmentItem[] }
export interface StockMovement {
  id: string; variant_id: string; product: { id: string; name: string };
  variant_title: string; sku: string | null; delta: number; on_hand_after: number;
  reason: StockMovementReason; note: string | null;
  reference: { type: 'import' | 'order'; id: string } | null;
  /** Phase 8.4: a movement made with an API key renders `{ type: 'api_key', id, name: "API: <key name>" }`. */
  actor: UserRef | { type: 'api_key'; id: string; name: string } | null; created_at: string;
}
export interface StockAdjustmentResult { items: InventoryItem[]; movements: StockMovement[] }
export interface StockMovementFilters {
  variant_id?: string; product_id?: string; reason?: StockMovementReason[];
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
  sort?: '-created_at' | 'name' | '-total_spent' | '-last_order_at'; page?: number; per_page?: number;
}
export interface CustomerListMeta extends PaginationMeta { counts: { all: number; new_this_month: number } }

// ---------- Imports / exports ----------
export type DataImportType = 'products' | 'customers';
export type DataImportStatus = 'uploaded' | 'validating' | 'validated' | 'importing' | 'completed' | 'failed' | 'cancelled';
export type ProductImportField =
  | 'handle' | 'name' | 'description' | 'status' | 'category' | 'tags'
  | 'option1_name' | 'option1_value' | 'option2_name' | 'option2_value' | 'option3_name' | 'option3_value'
  | 'sku' | 'barcode' | 'price' | 'compare_at_price' | 'cost_price' | 'stock' | 'weight_kg'
  | 'seo_title' | 'seo_description' | 'image_urls';
export type CustomerImportField = 'name' | 'phone' | 'email' | 'district' | 'area' | 'channel' | 'tags' | 'accepts_marketing' | 'note';
export type ImportField = ProductImportField | CustomerImportField;
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
    | 'payment_link' | 'items_edited' | 'return' | 'document';
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
}
export interface OrderListMeta extends PaginationMeta { counts: Record<'all' | OrderStatus, number> }
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
export interface ProfitSummary {
  revenue_amount: number; delivered_orders_count: number;
  product_cost_amount: number; delivery_cost_amount: number; cod_fee_amount: number;
  gateway_fee_amount: number | null; ad_spend_amount: number | null;
  total_cost_amount: number; net_profit_amount: number; margin: number | null;
  profit_per_order_amount: number | null;
}
export interface ProfitReport {
  summary: ProfitSummary; previous: ProfitSummary;
  per_order: {
    order_value_amount: number; product_cost_amount: number; delivery_cost_amount: number;
    cod_fee_amount: number; gateway_fee_amount: number | null; profit_amount: number;
  } | null;
  weekly: { week: string; week_start: string; revenue_amount: number; net_profit_amount: number; margin: number | null }[];
  daily: ({ date: string; orders_count: number } & Omit<ProfitSummary, 'delivered_orders_count' | 'profit_per_order_amount'>)[];
  data_quality: { items_without_cost: number; shipments_without_fee: number };
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
  /** P85-25 risk class `risky` */
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
  /** percent of `recipients`, one decimal */
  risk_breakdown: { good: number; careful: number; risky: number };
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
  | { field: 'customer.risk'; op: 'is_not'; value: 'risky' };
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
