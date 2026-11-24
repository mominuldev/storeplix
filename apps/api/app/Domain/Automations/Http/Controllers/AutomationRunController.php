<?php

declare(strict_types=1);

namespace App\Domain\Automations\Http\Controllers;

use App\Domain\Automations\Http\Resources\RunPresenter;
use App\Domain\Automations\Models\AutomationRun;
use App\Domain\Automations\Recipes\RecipeCatalogue;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Validation\Rule;

/**
 * PHASE-8-6 §9.1 run log (C7): `filter[automation_id|recipe|status|since]` (top-level names accepted too), cursor pages
 * of 50, newest first. Names need customers.view (P86-18); addresses are always masked.
 */
class AutomationRunController
{
    public function __construct(private readonly TenantContext $context) {}

    public function index(Request $request, Store $store): JsonResponse
    {
        $statuses = implode('|', AutomationRun::STATUSES);
        $request->validate([
            'filter' => ['sometimes', 'array:automation_id,recipe,status,since'],
            'filter.automation_id' => ['sometimes', 'string', 'size:26'],
            'filter.recipe' => ['sometimes', 'string', Rule::in(RecipeCatalogue::KEYS)],
            'filter.status' => ['sometimes', 'string', "regex:/^({$statuses})(,({$statuses}))*$/"],
            'filter.since' => ['sometimes', 'date'],
            'automation_id' => ['sometimes', 'string', 'size:26'],
            'recipe' => ['sometimes', 'string', Rule::in(RecipeCatalogue::KEYS)],
            'status' => ['sometimes', 'string', "regex:/^({$statuses})(,({$statuses}))*$/"],
            'since' => ['sometimes', 'date'],
            'cursor' => ['sometimes', 'nullable', 'string', 'max:512'],
        ]);
        $f = fn (string $k) => $request->input("filter.{$k}", $request->input($k));
        $query = AutomationRun::query()->where('store_id', $store->id);
        if (($id = $f('automation_id')) !== null) {
            $query->where('automation_id', strtolower((string) $id));
        }
        if (($recipe = $f('recipe')) !== null) {
            $query->whereIn('automation_id', fn ($q) => $q->select('id')->from('automations')->where('store_id', $store->id)->where('recipe', $recipe));
        }
        if (($status = $f('status')) !== null) {
            $query->whereIn('status', explode(',', (string) $status));
        }
        if (($since = $f('since')) !== null) {
            $query->where('created_at', '>=', Carbon::parse((string) $since)->utc());
        }
        $page = $query->orderByDesc('created_at')->orderByDesc('id')->cursorPaginate(50, ['*'], 'cursor', $request->input('cursor'));

        return new JsonResponse([
            'data' => RunPresenter::many(collect($page->items()), $this->names()),
            'meta' => [
                'next_cursor' => $page->nextCursor()?->encode(),
                'prev_cursor' => $page->previousCursor()?->encode(),
                'per_page' => $page->perPage(),
            ],
        ]);
    }

    public function show(Store $store, string $run): JsonResponse
    {
        $row = AutomationRun::query()->where('store_id', $store->id)->whereKey(strtolower($run))->firstOrFail();

        return new JsonResponse(['data' => RunPresenter::many(collect([$row]), $this->names())[0]]);
    }

    private function names(): bool
    {
        return $this->context->allows(Permission::CustomersView);
    }
}
