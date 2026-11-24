<?php

namespace App\Domain\Customers\Http\Resources;

use App\Domain\Customers\Models\Customer;
use App\Domain\Customers\Models\CustomerNote;
use App\Domain\FraudGuard\RiskTier;
use App\Domain\Marketing\Suppressions;
use App\Domain\Shared\Http\UserRef;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\TenantContext;

/** Customer / CustomerDetail / CustomerNote payloads (@storeplix/types). */
final class CustomerPresenter
{
    /** @return array<string, mixed> */
    public static function customer(Customer $customer, string $currency, int $notesCount): array
    {
        return [
            'id' => $customer->id,
            'name' => $customer->name,
            'phone' => $customer->phone,
            'email' => $customer->email,
            'district' => $customer->district,
            'area' => $customer->area,
            'channel' => $customer->channel,
            'source' => $customer->source,
            'tags' => $customer->tags ?? [],
            'accepts_marketing' => $customer->accepts_marketing,
            'orders_count' => $customer->orders_count,
            'total_spent_amount' => $customer->total_spent_amount,
            'currency' => $currency,
            'last_order_at' => UserRef::iso($customer->last_order_at),
            'delivered_orders_count' => (int) $customer->delivered_orders_count,
            'returned_orders_count' => (int) $customer->returned_orders_count,
            'notes_count' => $notesCount,
            'revision' => $customer->revision,
            'created_at' => UserRef::iso($customer->created_at),
            'updated_at' => UserRef::iso($customer->updated_at),
            'created_by' => UserRef::of($customer->createdBy),
            // PHASE-8-5 §4.1: computed per-channel marketing status (suppressions + eligibility P85-3).
            'marketing' => Suppressions::customerMarketing($customer),
            // PHASE-8-8 §6.5: own-shop risk tier (P88-4; replaces the 8.5 risk class).
            'risk' => RiskTier::payload($customer),
        ];
    }

    /** @return array<string, mixed> */
    public static function note(CustomerNote $note, ?string $userId): array
    {
        return [
            'id' => $note->id,
            'body' => $note->body,
            'author' => UserRef::of($note->author),
            'created_at' => UserRef::iso($note->created_at),
            'can_delete' => self::canDeleteNote($note, $userId),
        ];
    }

    public static function canDeleteNote(CustomerNote $note, ?string $userId): bool
    {
        return ($userId !== null && $note->author_user_id === $userId)
            || app(TenantContext::class)->allows(Permission::CustomersDelete);
    }
}
