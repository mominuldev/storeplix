<?php

namespace App\Domain\Customers\Http\Controllers;

use App\Domain\Catalog\Support\StockSql;
use App\Domain\Customers\CustomerService;
use App\Domain\Customers\Http\Requests\CustomerRequest;
use App\Domain\Customers\Http\Resources\CustomerPresenter;
use App\Domain\Customers\Models\Customer;
use App\Domain\Customers\Models\CustomerNote;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Support\Phone;
use App\Domain\Stores\Models\Store;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Gate;

/** §3.5 customers and notes. */
class CustomerController
{
    public function __construct(private readonly CustomerService $customers) {}

    /** GET /stores/{store}/customers */
    public function index(Request $request, Store $store): JsonResponse
    {
        Gate::authorize('view', $store);
        $channels = implode('|', Customer::CHANNELS);
        $input = $request->validate([
            'filter' => ['sometimes', 'array:channel,created_at,tag'],
            'filter.channel' => ['sometimes', 'string', "regex:/^({$channels})(,({$channels}))*$/"],
            'filter.created_at' => ['sometimes', 'array:gte'],
            'filter.created_at.gte' => ['sometimes', 'date'],
            'filter.tag' => ['sometimes', 'string', 'max:40'],
            'q' => ['sometimes', 'nullable', 'string', 'max:100'],
            'sort' => ['sometimes', 'string', 'in:-created_at,name,-total_spent,-last_order_at'],
            'page' => ['sometimes', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:100'],
        ]);

        $query = self::filtered($store, $input['filter'] ?? [], trim((string) ($input['q'] ?? '')));
        match ($input['sort'] ?? '-created_at') {
            'name' => $query->orderBy('name')->orderBy('id'),
            '-total_spent' => $query->orderByDesc('total_spent_amount')->orderByDesc('id'),
            '-last_order_at' => $query->orderByDesc('last_order_at')->orderByDesc('id'),
            default => $query->orderByDesc('created_at')->orderByDesc('id'),
        };
        $paginator = $query->with('createdBy')->withCount('notes')->paginate((int) ($input['per_page'] ?? 25));

        return new JsonResponse([
            'data' => $paginator->getCollection()->map(fn (Customer $c) => CustomerPresenter::customer($c, $store->currency, (int) $c->notes_count))->all(),
            'meta' => [
                'current_page' => $paginator->currentPage(),
                'per_page' => $paginator->perPage(),
                'total' => $paginator->total(),
                'last_page' => $paginator->lastPage(),
                'counts' => [
                    'all' => Customer::query()->where('store_id', $store->id)->count(),
                    'new_this_month' => Customer::query()->where('store_id', $store->id)->where('created_at', '>=', self::monthStart($store))->count(),
                ],
            ],
        ]);
    }

    public function store(CustomerRequest $request, Store $store): JsonResponse
    {
        $customer = $this->customers->create($store, $request->customerInput(), $request->user());

        return $this->detail($request, $store, $customer, 201);
    }

    public function show(Request $request, Store $store, Customer $customer): JsonResponse
    {
        Gate::authorize('view', $customer);

        return $this->detail($request, $store, $customer);
    }

    public function update(CustomerRequest $request, Store $store, Customer $customer): JsonResponse
    {
        Gate::authorize('update', $customer);
        $input = $request->customerInput();
        $customer = $this->customers->update($store, $customer, $input, (int) $input['revision'], $request->user());

        return $this->detail($request, $store, $customer);
    }

    public function destroy(Store $store, Customer $customer): Response
    {
        Gate::authorize('delete', $customer);
        $this->customers->delete($customer);

        return response()->noContent();
    }

    /** POST /stores/{store}/customers/{customer}/notes */
    public function addNote(Request $request, Store $store, Customer $customer): JsonResponse
    {
        Gate::authorize('update', $customer);
        $input = $request->validate(['body' => ['required', 'string', 'min:1', 'max:1000', 'regex:/^[^\x00-\x09\x0B-\x1F\x7F]*$/u']]);
        $note = $this->customers->addNote($customer, $input['body'], $request->user());

        return new JsonResponse(['data' => CustomerPresenter::note($note->load('author'), $request->user()?->getKey())], 201);
    }

    /** DELETE /stores/{store}/customers/{customer}/notes/{note} — author, or owner/admin. */
    public function deleteNote(Request $request, Store $store, Customer $customer, CustomerNote $note): Response
    {
        Gate::authorize('view', $customer);
        if (! CustomerPresenter::canDeleteNote($note, $request->user()?->getKey())) {
            throw new ApiException(403, 'forbidden', 'Only the author or an owner/admin can delete this note.');
        }
        $note->delete();

        return response()->noContent();
    }

    /**
     * Shared by the list and the customers export.
     *
     * @param  array<string, mixed>  $filter
     */
    public static function filtered(Store $store, array $filter, string $q): Builder
    {
        $query = Customer::query()->where('store_id', $store->id);
        if (isset($filter['channel'])) {
            $query->whereIn('channel', is_array($filter['channel']) ? $filter['channel'] : explode(',', $filter['channel']));
        }
        if (isset($filter['created_at']['gte'])) {
            $query->where('created_at', '>=', Carbon::parse($filter['created_at']['gte']));
        }
        if (isset($filter['tag']) && $filter['tag'] !== '') {
            $query->whereJsonContains('tags', mb_strtolower(trim($filter['tag'])));
        }
        if ($q !== '') {
            $digits = ltrim(Phone::clean($q), '+');
            $op = StockSql::like();
            if (ctype_digit($digits) && strlen($digits) >= 4) {
                if (str_starts_with($digits, '01')) {
                    $query->where('phone', 'like', '88'.$digits.'%');
                } elseif (str_starts_with($digits, '8801')) {
                    $query->where('phone', 'like', $digits.'%');
                } else {
                    $query->where('phone', 'like', '%'.$digits.'%');
                }
            } elseif (str_contains($q, '@')) {
                $query->where('email', 'like', StockSql::contains(mb_strtolower($q)));
            } else {
                $query->where('name', $op, StockSql::contains($q));
            }
        }

        return $query;
    }

    /** First instant of the current month in the store timezone (as UTC). */
    public static function monthStart(Store $store): Carbon
    {
        return Carbon::now($store->timezone ?: 'Asia/Dhaka')->startOfMonth()->utc();
    }

    private function detail(Request $request, Store $store, Customer $customer, int $status = 200): JsonResponse
    {
        $customer = Customer::query()->whereKey($customer->id)->with('createdBy')->withCount('notes')->firstOrFail();
        $notes = CustomerNote::query()->where('customer_id', $customer->id)->with('author')
            ->orderByDesc('created_at')->orderByDesc('id')->limit(100)->get();
        $userId = $request->user()?->getKey();

        return new JsonResponse(['data' => CustomerPresenter::customer($customer, $store->currency, (int) $customer->notes_count) + [
            'notes' => $notes->map(fn (CustomerNote $n) => CustomerPresenter::note($n, $userId))->all(),
        ]], $status);
    }
}
