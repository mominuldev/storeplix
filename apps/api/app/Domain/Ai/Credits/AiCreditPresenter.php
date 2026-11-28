<?php

declare(strict_types=1);

namespace App\Domain\Ai\Credits;

use App\Domain\Ai\Models\AiCreditLedgerEntry;
use App\Domain\Shared\Http\UserRef;
use Illuminate\Http\Request;

/** AiCreditLedgerEntry / AdminAiCredits (PHASE-8-9D §10; @storeplix/types). Never an actor id, key or request hash. */
final class AiCreditPresenter
{
    /** @return array<string, mixed> */
    public static function entry(AiCreditLedgerEntry $e): array
    {
        $generation = $e->ai_generation_id !== null ? $e->generation : null;

        return [
            'id' => $e->id,
            'type' => $e->type,
            'source' => $e->source,
            'credits' => $e->credits,
            'bonus_after' => $e->bonus_after,
            'period' => $e->period,
            'generation' => $e->ai_generation_id === null ? null : ['id' => $e->ai_generation_id, 'kind' => $generation?->kind ?? 'product_description'],
            'reason' => $e->type === AiCreditLedgerEntry::ADMIN_ADJUST ? $e->reason : null,
            'created_at' => UserRef::iso($e->created_at),
        ];
    }

    /** @return array<string, mixed> AdminAiCredits */
    public static function admin(AiCreditCharger $charger, string $tenantId): array
    {
        return [
            'tenant_id' => $tenantId,
            'credits' => $charger->summary(),
            'last_adjusted_at' => UserRef::iso($charger->find()?->last_adjusted_at),
        ];
    }

    /**
     * §10.3: newest first, 50, cursor, `filter[type]` comma list. Inside the tenant context.
     *
     * @return array{data: list<array<string, mixed>>, meta: array{next_cursor: string|null, prev_cursor: string|null, per_page: int}}
     */
    public static function ledgerPage(Request $request, string $tenantId): array
    {
        $types = implode('|', AiCreditLedgerEntry::TYPES);
        $input = $request->validate([
            'filter' => ['sometimes', 'array:type'],
            'filter.type' => ['sometimes', 'string', "regex:/^({$types})(,({$types}))*$/"],
            'cursor' => ['sometimes', 'nullable', 'string', 'max:512'],
        ]);
        $page = AiCreditLedgerEntry::query()->where('tenant_id', $tenantId)->with('generation:id,tenant_id,kind')
            ->when(isset($input['filter']['type']), fn ($q) => $q->whereIn('type', explode(',', $input['filter']['type'])))
            ->orderByDesc('created_at')->orderByDesc('id')
            ->cursorPaginate(50, ['*'], 'cursor', $input['cursor'] ?? null);

        return [
            'data' => array_values(array_map(fn (AiCreditLedgerEntry $e) => self::entry($e), $page->items())),
            'meta' => ['next_cursor' => $page->nextCursor()?->encode(), 'prev_cursor' => $page->previousCursor()?->encode(), 'per_page' => $page->perPage()],
        ];
    }
}
