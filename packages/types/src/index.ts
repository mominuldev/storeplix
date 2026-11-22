// API contract shared by all TS apps. Mirrors Laravel API Resources in apps/api.
// Change here => change the Laravel resource in the same PR (see docs/api/API-CONVENTIONS.md).

export interface ApiSuccess<T> { data: T; meta?: PaginationMeta | Record<string, unknown> }
export interface ApiError { error: { code: string; message: string; details?: Record<string, string[]>; /** seconds; present on 429 (also sent as Retry-After header) */ retry_after?: number } }
export interface PaginationMeta { current_page: number; per_page: number; total: number; last_page: number }

export interface HealthStatus { status: 'ok'; version: string; time: string }

export type TenantRole = 'owner' | 'admin' | 'staff';
export interface TenantMembership { id: string; name: string; role: TenantRole }
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
export type AssignableRole = Exclude<TenantRole, 'owner'>;
export interface StaffMember {
  id: string;                       // tenant_users.id (kind=member) or staff_invitations.id (kind=invitation)
  kind: 'member' | 'invitation';
  user_id: string | null;           // null for invitations
  name: string | null;              // invitation name may be null
  email: string;
  phone: string | null;
  role: TenantRole;
  status: 'active' | 'invited' | 'expired';
  is_you: boolean;
  invited_by: { id: string; name: string } | null;
  joined_at: string | null;
  expires_at: string | null;        // invitations only
  created_at: string;
}
export interface StaffSeatsMeta { seats_used: number; seats_limit: number | null }
export interface InviteStaffInput { email: string; name?: string | null; role: AssignableRole }
export interface UpdateStaffRoleInput { role: AssignableRole }
export interface InvitationPreview {
  tenant_name: string; store_name: string | null; email: string; role: AssignableRole;
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
  checkout?: { cod_enabled?: boolean };
  order_prefix?: string;
  notifications?: { new_order_email?: boolean; sms_language?: 'bn' | 'en'; customer_sms?: Partial<Record<CustomerSmsEvent, boolean>> };
}

// ---------- Plans / subscription / features ----------
export type FeatureKey =
  | 'custom_domain' | 'all_couriers' | 'bulk_courier_booking' | 'fake_order_guard' | 'sms_automation'
  | 'custom_roles' | 'multi_warehouse' | 'pos' | 'profit_reports' | 'api_webhooks';
export type LimitKey = 'orders_per_month' | 'staff_seats' | 'products' | 'courier_connections' | 'sms_per_month';
export interface Plan {
  id: string; code: 'free' | 'starter' | 'growth' | (string & {}); name: string;
  price_amount: number; currency: string; interval: 'month' | 'year';
  limits: Record<LimitKey, number | null>; features: FeatureKey[];
}
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'cancelled' | 'expired';
export interface Subscription {
  id: string; status: SubscriptionStatus; plan: Plan;
  trial_ends_at: string | null; current_period_start: string | null; current_period_end: string | null;
  cancel_at_period_end: boolean;
}
export interface FeatureAccess {
  plan_code: string; subscription_status: SubscriptionStatus; trial_ends_at: string | null;
  features: Record<FeatureKey, boolean>;
  limits: Record<LimitKey, { limit: number | null; used: number }>;
}

// ---------- Audit ----------
export interface AuditLog {
  id: string; action: string;
  actor: { type: 'user' | 'system'; id: string | null; name: string | null } | null;
  subject: { type: string; id: string } | null;
  meta: Record<string, unknown>;
  ip: string | null; user_agent: string | null; created_at: string;
}
export interface AuditLogFilters {
  action?: string; actor_id?: string; subject_id?: string;
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
export interface MeMeta { session_expires_at: string | null }

// ---------- Permissions surfaced to the UI ----------
/** Mirrors App\Domain\Tenancy\Authorization\Permission (P4-14). UI derives from TenantMembership.role. */
export const ROLE_CAN = {
  view_costs: ['owner', 'admin'],
  manage_catalog: ['owner', 'admin'],   // delete products/categories/customers
  bulk_data: ['owner', 'admin'],        // imports & exports
  manage_marketing: ['owner', 'admin'], // coupons (P5-21)
  manage_refunds: ['owner', 'admin'],   // refunds, cancelling paid orders
  manage_settings: ['owner', 'admin'],  // shipping, checkout, notifications, publish
  manage_integrations: ['owner', 'admin'], // gateways, couriers (5b)
} as const satisfies Record<string, readonly TenantRole[]>;

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
  reference: { type: 'import' | 'order'; id: string } | null; actor: UserRef | null; created_at: string;
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
  shipment: { carrier_name: string | null; tracking_code: string | null; tracking_url: string | null } | null;
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
  actor: { type: 'user' | 'customer' | 'system'; user: UserRef | null };
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
  waiting: { pending: number; confirmed: number; ready_to_ship: number };
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
