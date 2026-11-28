<?php

declare(strict_types=1);

namespace App\Domain\Sms\Http\Requests;

use App\Domain\Shared\Support\Phone;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Sms\SmsPurposes;
use App\Domain\Stores\Models\Store;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Validator;

/** GET /stores/{store}/sms/messages filters (PHASE-8-9A §9, P89A-19); a bad list value, date or phone → 422. */
class SmsLogRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true; // perm:settings.manage|integrations.manage on the route
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        $purposes = implode('|', SmsPurposes::LISTED);
        $statuses = implode('|', SmsMessage::STATUSES);

        return [
            'filter' => ['sometimes', 'array:purpose,status,from,to,phone'],
            'filter.purpose' => ['sometimes', 'string', "regex:/^({$purposes})(,({$purposes}))*$/"],
            'filter.status' => ['sometimes', 'string', "regex:/^({$statuses})(,({$statuses}))*$/"],
            'filter.from' => ['sometimes', 'date_format:Y-m-d'],
            'filter.to' => ['sometimes', 'date_format:Y-m-d'],
            'filter.phone' => ['sometimes', 'string', 'max:20'],
            'cursor' => ['sometimes', 'nullable', 'string', 'max:512'],
        ];
    }

    public function after(): array
    {
        return [function (Validator $v) {
            $filter = (array) $this->input('filter', []);
            if (isset($filter['phone']) && is_string($filter['phone']) && Phone::bdMsisdn($filter['phone']) === null) {
                $v->errors()->add('filter.phone', 'Enter a full phone number.');
            }
            $store = $this->route('store');
            $tz = $store instanceof Store ? (string) ($store->timezone ?: 'Asia/Dhaka') : 'Asia/Dhaka';
            $min = now($tz)->subDays((int) config('sms.log_days', 90))->format('Y-m-d');
            if (isset($filter['from']) && is_string($filter['from']) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $filter['from']) && $filter['from'] < $min) {
                $v->errors()->add('filter.from', "The SMS log goes back to {$min}.");
            }
            if (isset($filter['from'], $filter['to']) && is_string($filter['to']) && $filter['to'] < $filter['from']) {
                $v->errors()->add('filter.to', 'The end date must be on or after the start date.');
            }
        }];
    }
}
