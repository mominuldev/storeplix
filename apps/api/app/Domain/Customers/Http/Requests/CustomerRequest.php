<?php

namespace App\Domain\Customers\Http\Requests;

use App\Domain\Customers\Models\Customer;
use App\Domain\Shared\Support\Phone;
use App\Domain\Stores\Models\Store;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Validator;

/**
 * CreateCustomerInput / UpdateCustomerInput (§3.5). orders_count, total_spent_amount, last_order_at, source and
 * revision (except as the lock value) are never writable: CustomerService maps fields explicitly.
 */
class CustomerRequest extends FormRequest
{
    public const PHONE_MESSAGE = 'Enter a Bangladeshi mobile number (01XXXXXXXXX).';

    public function authorize(): bool
    {
        /** @var Store $store */
        $store = $this->route('store');

        return $this->user()->can('view', $store);
    }

    protected function prepareForValidation(): void
    {
        $in = $this->all();
        foreach (['name', 'phone', 'email', 'district', 'area'] as $key) {
            if (isset($in[$key]) && is_string($in[$key])) {
                $in[$key] = trim($in[$key]) === '' ? null : trim($in[$key]);
            }
        }
        if (isset($in['email']) && is_string($in['email'])) {
            $in['email'] = mb_strtolower($in['email']);
        }
        if (isset($in['tags']) && is_array($in['tags'])) {
            $in['tags'] = array_map(fn ($t) => is_string($t) ? mb_strtolower(trim($t)) : $t, $in['tags']);
        }
        $this->replace($in);
    }

    public function rules(): array
    {
        $create = $this->isMethod('POST');
        $noControl = 'regex:/^[^\x00-\x1F\x7F]*$/u';

        return [
            'name' => [$create ? 'required' : 'sometimes', 'string', 'min:1', 'max:120', $noControl],
            'phone' => ['sometimes', 'nullable', 'string', 'max:20'],
            'email' => ['sometimes', 'nullable', 'string', 'max:254', 'email:rfc'],
            'district' => ['sometimes', 'nullable', 'string', 'max:80', $noControl],
            'area' => ['sometimes', 'nullable', 'string', 'max:120', $noControl],
            'channel' => ['sometimes', 'nullable', 'string', Rule::in(Customer::CHANNELS)],
            'tags' => ['sometimes', 'array', 'max:20'],
            'tags.*' => ['string', 'min:1', 'max:40', $noControl],
            'accepts_marketing' => ['sometimes', 'boolean:strict'],
            'revision' => $create ? ['exclude'] : ['required', 'integer'],
        ];
    }

    public function after(): array
    {
        return [function (Validator $validator) {
            $phone = $this->input('phone');
            if (is_string($phone) && Phone::bdMsisdn($phone) === null) {
                $validator->errors()->add('phone', self::PHONE_MESSAGE);
            }
            if ($this->isMethod('POST') && $this->input('phone') === null && $this->input('email') === null) {
                $validator->errors()->add('phone', 'Enter a phone number or an email.');
            }
        }];
    }

    /** @return array<string, mixed> validated input with the phone normalised to 8801XXXXXXXXX */
    public function customerInput(): array
    {
        $input = $this->validated();
        if (array_key_exists('phone', $input)) {
            $input['phone'] = Phone::bdMsisdn($input['phone']);
        }
        if (array_key_exists('tags', $input)) {
            $input['tags'] = array_values(array_unique($input['tags']));
        }

        return $input;
    }
}
