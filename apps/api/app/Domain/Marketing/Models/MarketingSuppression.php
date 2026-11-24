<?php

declare(strict_types=1);

namespace App\Domain\Marketing\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Opt-out of one normalized address on one channel in one store (P85-4, §4.1): the source of truth for opt-out,
 * independent of customer rows. `link` rows are customer-owned (P85-5): only the customer removes them.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $channel
 * @property string $address
 * @property string $source link|merchant|import
 * @property string|null $campaign_id
 * @property string|null $created_by
 * @property Carbon|null $created_at
 */
class MarketingSuppression extends Model
{
    use BelongsToTenant, HasUlids;

    public const UPDATED_AT = null;

    public const LINK = 'link';

    public const MERCHANT = 'merchant';

    public const IMPORT = 'import';

    protected $fillable = [];
}
