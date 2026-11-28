<?php

declare(strict_types=1);

namespace App\Domain\Sms\Credits;

use App\Domain\Sms\Models\SmsCreditLedgerEntry;
use Illuminate\Http\Request;

/** PHASE-8-9A §5.5: ledger page (newest first, 50, cursor, `filter[type]` comma list). Inside the tenant context. */
final class SmsCreditLedgerQuery
{
    public const PER_PAGE = 50;

    /** @return array{data: list<array<string, mixed>>, meta: array{next_cursor: string|null, prev_cursor: string|null, per_page: int}} */
    public static function page(Request $request, string $tenantId): array
    {
        $types = implode('|', SmsCreditLedgerEntry::TYPES);
        $input = $request->validate([
            'filter' => ['sometimes', 'array:type'],
            'filter.type' => ['sometimes', 'string', "regex:/^({$types})(,({$types}))*$/"],
            'cursor' => ['sometimes', 'nullable', 'string', 'max:512'],
        ]);
        $page = SmsCreditLedgerEntry::query()->where('tenant_id', $tenantId)->with('invoice:id,tenant_id,number')
            ->when(isset($input['filter']['type']), fn ($q) => $q->whereIn('type', explode(',', $input['filter']['type'])))
            ->orderByDesc('created_at')->orderByDesc('id')
            ->cursorPaginate(self::PER_PAGE, ['*'], 'cursor', $input['cursor'] ?? null);

        return [
            'data' => array_values(array_map(fn (SmsCreditLedgerEntry $e) => SmsCreditPresenter::entry($e), $page->items())),
            'meta' => ['next_cursor' => $page->nextCursor()?->encode(), 'prev_cursor' => $page->previousCursor()?->encode(), 'per_page' => $page->perPage()],
        ];
    }
}
