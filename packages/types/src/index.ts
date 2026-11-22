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
}

// ---------- Plans / subscription / features ----------
export type FeatureKey =
  | 'custom_domain' | 'all_couriers' | 'bulk_courier_booking' | 'fake_order_guard' | 'sms_automation'
  | 'custom_roles' | 'multi_warehouse' | 'pos' | 'profit_reports' | 'api_webhooks';
export type LimitKey = 'orders_per_month' | 'staff_seats' | 'products' | 'courier_connections';
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
  action?: string; actor_id?: string; subject_type?: string; subject_id?: string;
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
export type StockMovementReason = 'initial' | 'received' | 'correction' | 'damaged' | 'lost' | 'returned' | 'import' | 'other';
export type ManualStockReason = Exclude<StockMovementReason, 'initial' | 'import'>;
export interface StockAdjustmentItem { variant_id: string; mode: 'delta' | 'set'; quantity: number; expected_on_hand?: number }
export interface StockAdjustmentInput { reason: ManualStockReason; note?: string | null; items: StockAdjustmentItem[] }
export interface StockMovement {
  id: string; variant_id: string; product: { id: string; name: string };
  variant_title: string; sku: string | null; delta: number; on_hand_after: number;
  reason: StockMovementReason; note: string | null;
  reference: { type: 'import'; id: string } | null; actor: UserRef | null; created_at: string;
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
  /** Phase 5 fills this; null means "no order data yet" → empty states. */
  orders: null;
  setup: { has_products: boolean };
}

// ---------- Storefront product feed ----------
export interface StorefrontProductCard {
  id: string; slug: string; name: string;
  subtitle: string | null;                                 // first category name
  price_amount: number; compare_at_amount: number | null; currency: string;
  on_sale: boolean; image: StorefrontMedia | null;
}
export interface StorefrontProductListMeta { has_products: boolean }
export interface StorefrontProductQuery { sort?: 'latest' | 'bestsellers'; limit?: number; on_sale?: boolean; category?: string }
