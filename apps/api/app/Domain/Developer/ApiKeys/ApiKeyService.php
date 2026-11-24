<?php

declare(strict_types=1);

namespace App\Domain\Developer\ApiKeys;

use App\Domain\Billing\Feature;
use App\Domain\Billing\FeatureGate;
use App\Domain\Developer\ApiKeys\Models\ApiKey;
use App\Domain\Identity\Models\User;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\Authorization\PermissionSet;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Facades\DB;

/**
 * PHASE-8-4 §2, §6.1 (P84-2, P84-5, P84-13, P84-14): create / rename / revoke API keys.
 *
 * Create: the plain key (`sp_live_` + 40 base62) exists only in the return value; the row keeps its sha256, the
 * display prefix and the last four characters. Scopes are normalised (implied reads added, de-duplicated) and each must
 * be grantable by the actor (non-delegation). Writes need `api_webhooks` (402) and at most 10 active keys per tenant.
 */
class ApiKeyService
{
    private const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

    private const RANDOM_LENGTH = 40;

    public function __construct(
        private readonly TenantContext $context,
        private readonly AuditLogger $audit,
    ) {}

    /** P84-13: management writes need the plan feature. */
    public function assertFeature(): void
    {
        FeatureGate::assertAllows($this->context->tenant(), Feature::ApiWebhooks);
    }

    /**
     * Non-delegation (P84-5, S105): every requested scope must be backed by a permission the actor holds;
     * `include_costs` needs `costs.view`.
     *
     * @param  list<ApiScope>  $scopes
     */
    public function assertGrantable(array $scopes, bool $includeCosts, PermissionSet $held): void
    {
        $denied = array_values(array_filter($scopes, fn (ApiScope $s) => ! $s->grantableBy($held)));
        if ($denied !== []) {
            throw new ApiException(422, 'scope_not_grantable', "You can't give a key access you don't have yourself.", [
                'scopes' => array_map(fn (ApiScope $s) => $s->value, $denied),
            ]);
        }
        if ($includeCosts && ! $held->has(Permission::CostsView)) {
            throw new ApiException(422, 'scope_not_grantable', "You can't give a key access you don't have yourself.", [
                'include_costs' => ['You need permission to see product costs.'],
            ]);
        }
    }

    /**
     * @param  array{name: string, scopes: list<string>, include_costs?: bool}  $input  validated
     * @return array{0: ApiKey, 1: string} the key row and the plain key (shown once)
     */
    public function create(array $input, User $actor): array
    {
        $scopes = ApiScope::normalize(array_map(fn (string $s) => ApiScope::from($s), $input['scopes']));
        $includeCosts = (bool) ($input['include_costs'] ?? false);
        $this->assertGrantable($scopes, $includeCosts, $this->context->permissions());

        $plain = self::generate();

        $key = DB::transaction(function () use ($input, $scopes, $includeCosts, $actor, $plain) {
            // Serialise concurrent creates of one tenant (the count below must not race).
            DB::table('tenants')->where('id', $this->context->requireId())->lockForUpdate()->value('id');
            if (ApiKey::query()->active()->count() >= ApiKey::MAX_ACTIVE) {
                throw new ApiException(422, 'limit_reached', 'You can have at most '.ApiKey::MAX_ACTIVE.' active API keys. Revoke one first.', [
                    'limit' => [(string) ApiKey::MAX_ACTIVE],
                ]);
            }

            $key = new ApiKey;
            $key->name = $input['name'];
            $key->prefix = substr($plain, 0, 12);
            $key->last_four = substr($plain, -4);
            $key->key_hash = self::hash($plain);
            $key->scopes = array_map(fn (ApiScope $s) => $s->value, $scopes);
            $key->include_costs = $includeCosts;
            $key->created_by_user_id = $actor->id;
            $key->save();

            return $key;
        });

        $this->audit->log('api_key.created', $key, [
            'name' => $key->name,
            'prefix' => $key->prefix,
            'scopes' => $key->scopes,
            'include_costs' => $key->include_costs,
        ]);

        return [$key, $plain];
    }

    public function rename(ApiKey $key, string $name): ApiKey
    {
        $from = $key->name;
        if ($from === $name) {
            return $key;
        }
        $key->name = $name;
        $key->save();
        $this->audit->log('api_key.renamed', $key, ['from' => $from, 'to' => $name]);

        return $key;
    }

    /** Idempotent: a revoked key stays revoked (no second audit row). The row is kept. */
    public function revoke(ApiKey $key, User $actor): ApiKey
    {
        $revoked = ApiKey::query()->whereKey($key->id)->whereNull('revoked_at')
            ->update(['revoked_at' => now(), 'revoked_by_user_id' => $actor->id, 'updated_at' => now()]);
        $key->refresh();
        if ($revoked === 1) {
            $this->audit->log('api_key.revoked', $key, ['name' => $key->name, 'prefix' => $key->prefix]);
        }

        return $key;
    }

    /** sha256 hex of the plain key (the only stored form). */
    public static function hash(string $plain): string
    {
        return hash('sha256', $plain);
    }

    /** `sp_live_` + 40 base62 characters from a CSPRNG (≈ 238 bits). */
    public static function generate(): string
    {
        $out = '';
        $max = strlen(self::ALPHABET) - 1;
        for ($i = 0; $i < self::RANDOM_LENGTH; $i++) {
            $out .= self::ALPHABET[random_int(0, $max)];
        }

        return ApiKey::PLAIN_PREFIX.$out;
    }
}
