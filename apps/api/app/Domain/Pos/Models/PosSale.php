<?php

declare(strict_types=1);

namespace App\Domain\Pos\Models;

use App\Domain\Identity\Models\User;
use App\Domain\Orders\Models\Order;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * The till facts of one till sale, 1:1 with its order (PHASE-8-8D §3.1, P88D-2, ADR 0025): register, session,
 * location, cashier, cash tendered and change. Money and lines live on the order. Insert-only (PosSaleService).
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $order_id
 * @property string $session_id
 * @property string $register_id
 * @property string $location_id
 * @property string $cashier_id
 * @property int|null $tendered_cash_amount
 * @property int $change_amount
 * @property bool $sms_receipt
 * @property Carbon $created_at
 * @property-read Order $order
 * @property-read PosSession $session
 * @property-read PosRegister $register
 * @property-read User $cashier
 */
class PosSale extends Model
{
    use BelongsToTenant, HasUlids;

    public const UPDATED_AT = null;

    protected $fillable = [];

    protected $attributes = ['change_amount' => 0, 'sms_receipt' => false];

    protected function casts(): array
    {
        return ['tendered_cash_amount' => 'integer', 'change_amount' => 'integer', 'sms_receipt' => 'boolean', 'created_at' => 'datetime'];
    }

    public function order(): BelongsTo
    {
        return $this->belongsTo(Order::class, 'order_id');
    }

    public function session(): BelongsTo
    {
        return $this->belongsTo(PosSession::class, 'session_id');
    }

    public function register(): BelongsTo
    {
        return $this->belongsTo(PosRegister::class, 'register_id');
    }

    public function cashier(): BelongsTo
    {
        return $this->belongsTo(User::class, 'cashier_id');
    }
}
