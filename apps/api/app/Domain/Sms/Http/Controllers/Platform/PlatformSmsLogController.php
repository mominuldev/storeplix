<?php

declare(strict_types=1);

namespace App\Domain\Sms\Http\Controllers\Platform;

use App\Domain\Admin\Tenants\AdminPresenter;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Sms\Platform\PlatformSmsLog;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Validator;
use Symfony\Component\HttpFoundation\StreamedResponse;

/** PHASE-8-9B §8, §9.1 `GET /admin/sms/messages` (+ `/export` CSV), platform permission `manage_settings`. */
class PlatformSmsLogController
{
    public function index(Request $request): JsonResponse
    {
        $input = $this->validated($request);
        $page = PlatformSmsLog::query($input['filter'] ?? [])->cursorPaginate(PlatformSmsLog::PER_PAGE, ['*'], 'cursor', $input['cursor'] ?? null);

        return AdminPresenter::json([
            'data' => PlatformSmsLog::present(collect($page->items())),
            'meta' => ['next_cursor' => $page->nextCursor()?->encode(), 'prev_cursor' => $page->previousCursor()?->encode(), 'per_page' => $page->perPage()],
        ]);
    }

    public function export(Request $request, AuditLogger $audit): StreamedResponse
    {
        $filter = $this->validated($request)['filter'] ?? [];
        $max = (int) config('sms.platform.export_max_rows', 50000);
        $count = PlatformSmsLog::query($filter)->count();
        if ($count > $max) {
            throw new ApiException(422, 'export_too_large', "Narrow the filters: an export holds at most {$max} rows.", ['max' => $max]);
        }
        $audit->log('platform_sms.log_exported', null, ['filters' => $filter, 'rows' => $count], $request->user(), tenantId: false, platform: true);
        $name = 'platform-sms-log-'.now()->timezone((string) config('sms.platform.timezone', 'Asia/Dhaka'))->format('Y-m-d').'.csv';

        return new StreamedResponse(function () use ($filter) {
            $out = fopen('php://output', 'w');
            fwrite($out, "\xEF\xBB\xBF");
            fputcsv($out, PlatformSmsLog::csvHeader(), escape: '');
            PlatformSmsLog::query($filter)->chunk(1000, function ($rows) use ($out) {
                foreach (PlatformSmsLog::present($rows) as $entry) {
                    fputcsv($out, PlatformSmsLog::csvRow($entry), escape: '');
                }
            });
            fclose($out);
        }, 200, [
            'Content-Type' => 'text/csv; charset=utf-8',
            'Content-Disposition' => 'attachment; filename="'.$name.'"',
            'Cache-Control' => 'private, no-store',
            'X-Content-Type-Options' => 'nosniff',
        ]);
    }

    /** @return array{filter?: array<string, string>, cursor?: string|null} */
    private function validated(Request $request): array
    {
        $statuses = implode('|', SmsMessage::STATUSES);
        $groups = 'registration|billing|security|promotional';
        $validator = validator($request->query(), [
            'filter' => ['sometimes', 'array:q,status,group,from,to'],
            'filter.q' => ['sometimes', 'nullable', 'string', 'min:2', 'max:100'],
            'filter.status' => ['sometimes', 'string', "regex:/^({$statuses})(,({$statuses}))*$/"],
            'filter.group' => ['sometimes', 'string', "regex:/^({$groups})(,({$groups}))*$/"],
            'filter.from' => ['sometimes', 'date_format:Y-m-d'],
            'filter.to' => ['sometimes', 'date_format:Y-m-d'],
            'cursor' => ['sometimes', 'nullable', 'string', 'max:512'],
        ]);
        $validator->after(function (Validator $v) use ($request) {
            $filter = (array) $request->query('filter', []);
            $min = now((string) config('sms.platform.timezone', 'Asia/Dhaka'))->subDays((int) config('sms.log_days', 90))->format('Y-m-d');
            foreach (['from', 'to'] as $key) {
                if (isset($filter[$key]) && is_string($filter[$key]) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $filter[$key]) === 1 && $filter[$key] < $min) {
                    $v->errors()->add("filter.{$key}", "The SMS log goes back to {$min}.");
                }
            }
            if (isset($filter['from'], $filter['to']) && is_string($filter['from']) && is_string($filter['to']) && $filter['to'] < $filter['from']) {
                $v->errors()->add('filter.to', 'The end date must be on or after the start date.');
            }
        });
        $input = $validator->validate();
        $input['filter'] = array_filter((array) ($input['filter'] ?? []), fn ($v) => $v !== null && $v !== '');

        return $input;
    }
}
