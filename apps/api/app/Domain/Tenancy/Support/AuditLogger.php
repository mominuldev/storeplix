<?php

namespace App\Domain\Tenancy\Support;

use App\Domain\Automations\Models\Automation;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Catalog\Models\Category;
use App\Domain\Catalog\Models\Product;
use App\Domain\Couriers\Models\CourierAccount;
use App\Domain\Customers\Models\Customer;
use App\Domain\DataTransfer\Models\DataExport;
use App\Domain\DataTransfer\Models\DataImport;
use App\Domain\Developer\ApiKeys\CurrentApiKey;
use App\Domain\Developer\ApiKeys\Models\ApiKey;
use App\Domain\Identity\Models\User;
use App\Domain\Identity\Support\SessionSurface;
use App\Domain\Inventory\Models\Location;
use App\Domain\Inventory\Models\StockCount;
use App\Domain\Inventory\Models\StockTransfer;
use App\Domain\Media\Models\Media;
use App\Domain\Navigation\Models\StoreNavigation;
use App\Domain\Pages\Models\StorePage;
use App\Domain\Payments\Models\PaymentGatewayAccount;
use App\Domain\Purchasing\Models\PurchaseOrder;
use App\Domain\Purchasing\Models\Supplier;
use App\Domain\Purchasing\Models\SupplierPayment;
use App\Domain\Staff\Models\StaffInvitation;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tenancy\TenantContext;
use App\Domain\Themes\Models\StoreTheme;
use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Http\Request;
use Illuminate\Support\Str;

/**
 * Writes the append-only audit trail. Callers pass ONLY redacted meta
 * (changed key names, role from/to) — never passwords, tokens or contact values.
 */
class AuditLogger
{
    /** Model class → public subject_type (AuditLog.subject.type / filter[subject_type]). */
    public const SUBJECT_TYPES = [
        Store::class => 'store',
        StoreSetting::class => 'store_settings',
        TenantUser::class => 'staff_member',
        StaffInvitation::class => 'staff_invitation',
        Media::class => 'media',
        Subscription::class => 'subscription',
        User::class => 'user',
        Tenant::class => 'tenant',
        StoreTheme::class => 'store_theme',
        StorePage::class => 'store_page',
        StoreNavigation::class => 'store_navigation',
        Product::class => 'product',
        Category::class => 'category',
        Customer::class => 'customer',
        DataImport::class => 'data_import',
        DataExport::class => 'data_export',
        PaymentGatewayAccount::class => 'payment_gateway',
        CourierAccount::class => 'courier',
        StoreDomain::class => 'store_domain',
        ApiKey::class => 'api_key',
        Automation::class => 'automation', // PHASE-8-6 §4.4
        Supplier::class => 'supplier', // PHASE-8-8B P88B-18
        PurchaseOrder::class => 'purchase_order',
        SupplierPayment::class => 'supplier_payment',
        Location::class => 'location', // PHASE-8-8C P88C-18
        StockTransfer::class => 'stock_transfer',
        StockCount::class => 'stock_count',
    ];

    public function __construct(
        private readonly TenantContext $context,
        private readonly ?Request $request = null,
    ) {}

    /**
     * @param  array<string, mixed>  $meta
     * @param  bool  $system  true for scheduler/queue actions with no human actor
     * @param  string|false|null  $tenantId  null = current context; false = force account-level (tenant_id null)
     * @param  bool|null  $platform  PHASE-8-1 P8-8: true = the actor acts as Storeplix staff (`actor_type: platform_user`,
     *                               `meta.platform_role`); null = inferred: the actor is the signed-in user on an
     *                               `admin` or `impersonation` session surface
     */
    public function log(
        string $action,
        ?Model $subject = null,
        array $meta = [],
        ?Authenticatable $actor = null,
        string|false|null $tenantId = null,
        bool $system = false,
        ?bool $platform = null,
    ): AuditLog {
        $requestUser = $system ? null : $this->request?->user();
        if (! $system) {
            $actor ??= $requestUser;
        }

        $platform = $actor !== null && ($platform ?? $this->onPlatformSurface($actor, $requestUser));
        if ($platform) {
            $meta['platform_role'] = $actor instanceof User ? $actor->platform_role : null;
        }

        // PHASE-8-4 §3: an external API request has no user; its API key is the actor (actor_id = key id).
        $apiKey = ($system || $actor !== null) ? null : CurrentApiKey::current();

        return AuditLog::query()->create([
            'tenant_id' => $tenantId === false ? null : ($tenantId ?? $this->context->id()),
            'actor_type' => $actor ? ($platform ? 'platform_user' : 'user') : ($apiKey !== null ? 'api_key' : 'system'),
            'actor_id' => $actor?->getAuthIdentifier() ?? $apiKey?->id,
            'action' => $action,
            'subject_type' => $subject ? (self::SUBJECT_TYPES[$subject::class] ?? Str::snake(class_basename($subject))) : null,
            'subject_id' => $subject?->getKey(),
            'ip' => $system ? null : $this->request?->ip(),
            'user_agent' => $system ? null : (Str::limit((string) $this->request?->userAgent(), 252, '...') ?: null),
            'meta' => $meta ?: null,
        ]);
    }

    private function onPlatformSurface(Authenticatable $actor, ?Authenticatable $requestUser): bool
    {
        if ($this->request === null || $requestUser === null || ! $this->request->hasSession()
            || $requestUser->getAuthIdentifier() !== $actor->getAuthIdentifier()) {
            return false;
        }

        return in_array(SessionSurface::of($this->request), [SessionSurface::ADMIN, SessionSurface::IMPERSONATION], true);
    }
}
