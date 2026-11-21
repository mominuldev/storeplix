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
export interface AuthToken { token: string; user: User; /** ISO-8601 */ expires_at: string }

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
