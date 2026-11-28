<?php

declare(strict_types=1);

namespace App\Domain\Sms\Http\Controllers;

use App\Domain\Shared\Support\Phone;
use App\Domain\Sms\Http\Requests\SmsLogRequest;
use App\Domain\Sms\SmsLogPresenter;
use App\Domain\Sms\SmsOverviewPresenter;
use App\Domain\Stores\Models\Store;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Carbon;

/**
 * PHASE-8-9A §9: GET /stores/{store}/sms/messages — this store's SMS of the last 90 days (store timezone), newest first,
 * 50 per page, cursor. Explicit tenant + store + `purpose NOT LIKE 'otp\_%'` filters (RLS is the backstop, S209).
 */
class SmsLogController
{
    private const PER_PAGE = 50;

    public function index(SmsLogRequest $request, Store $store): JsonResponse
    {
        $input = $request->validated();
        $filter = $input['filter'] ?? [];
        $tz = (string) ($store->timezone ?: 'Asia/Dhaka');
        $windowStart = now($tz)->subDays((int) config('sms.log_days', 90))->startOfDay()->utc();
        $from = isset($filter['from']) ? Carbon::createFromFormat('Y-m-d', $filter['from'], $tz)->startOfDay()->utc() : null;
        $to = isset($filter['to']) ? Carbon::createFromFormat('Y-m-d', $filter['to'], $tz)->endOfDay()->utc() : null;

        $page = SmsOverviewPresenter::listed($store)
            ->where('created_at', '>=', $from !== null && $from->gt($windowStart) ? $from : $windowStart)
            ->when($to !== null, fn ($q) => $q->where('created_at', '<=', $to))
            ->when(isset($filter['purpose']), fn ($q) => $q->whereIn('purpose', explode(',', $filter['purpose'])))
            ->when(isset($filter['status']), fn ($q) => $q->whereIn('status', explode(',', $filter['status'])))
            ->when(isset($filter['phone']), fn ($q) => $q->where('to', Phone::bdMsisdn($filter['phone'])))
            ->orderByDesc('created_at')->orderByDesc('id')
            ->cursorPaginate(self::PER_PAGE, ['*'], 'cursor', $input['cursor'] ?? null);

        return new JsonResponse([
            'data' => SmsLogPresenter::many(collect($page->items())),
            'meta' => [
                'next_cursor' => $page->nextCursor()?->encode(),
                'prev_cursor' => $page->previousCursor()?->encode(),
                'per_page' => $page->perPage(),
            ],
        ], 200, ['Cache-Control' => 'private, no-store']);
    }
}
