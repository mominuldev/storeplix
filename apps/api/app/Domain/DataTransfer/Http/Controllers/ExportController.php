<?php

namespace App\Domain\DataTransfer\Http\Controllers;

use App\Domain\Customers\Models\Customer;
use App\Domain\DataTransfer\Http\Resources\DataTransferPresenter;
use App\Domain\DataTransfer\Jobs\RunExport;
use App\Domain\DataTransfer\Models\DataExport;
use App\Domain\Media\TenantStorage;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Symfony\Component\HttpFoundation\StreamedResponse;

/** §3.4 exports: always queued, private file, 5-minute signed download URL, 24 h retention. */
class ExportController
{
    public function __construct(private readonly AuditLogger $audit) {}

    /** POST /stores/{store}/exports */
    public function store(Request $request, Store $store): JsonResponse
    {
        $this->authorize($store);
        $input = $request->validate([
            'type' => ['required', 'string', 'in:products,customers'],
            'filters' => ['sometimes', 'array'],
        ]);
        $rules = $input['type'] === 'products' ? [
            'filters' => ['sometimes', 'array:status,category_id,stock,q,ids'],
            'filters.status' => ['sometimes', 'array'],
            'filters.status.*' => ['string', 'in:draft,active,archived'],
            'filters.category_id' => ['sometimes', 'nullable', 'string', 'size:26'],
            'filters.stock' => ['sometimes', 'nullable', 'string', 'in:in,low,out'],
            'filters.q' => ['sometimes', 'nullable', 'string', 'max:100'],
            'filters.ids' => ['sometimes', 'array', 'max:1000'],
            'filters.ids.*' => ['string', 'size:26'],
        ] : [
            'filters' => ['sometimes', 'array:q,channel,tag,created_from'],
            'filters.q' => ['sometimes', 'nullable', 'string', 'max:100'],
            'filters.channel' => ['sometimes', 'array'],
            'filters.channel.*' => ['string', 'in:'.implode(',', Customer::CHANNELS)],
            'filters.tag' => ['sometimes', 'nullable', 'string', 'max:40'],
            'filters.created_from' => ['sometimes', 'nullable', 'date'],
        ];
        $filters = $request->validate($rules)['filters'] ?? [];

        $export = new DataExport([
            'type' => $input['type'],
            'status' => DataExport::QUEUED,
            'filters' => $filters,
            'created_by' => $request->user()?->getKey(),
        ]);
        $export->store_id = $store->id;
        $export->save();

        $this->audit->log('export.created', $export, ['type' => $export->type, 'filters' => $filters]);
        if ($export->type === 'customers') {
            $this->audit->log('customer.exported', $export, ['filters' => $filters]);
        }

        RunExport::dispatch($export->id)->forTenant($export->tenant_id);

        return new JsonResponse(['data' => DataTransferPresenter::export($export->refresh()->load('createdBy'), $store)], 202);
    }

    public function show(Store $store, DataExport $export): JsonResponse
    {
        $this->authorize($store);

        return new JsonResponse(['data' => DataTransferPresenter::export($export->load('createdBy'), $store)]);
    }

    /** GET /exports/{export}/download (signed, 5 min; local/private disks only). Tenant comes from the signed URL. */
    public function download(Request $request, string $export, TenantContext $context, TenantStorage $storage): StreamedResponse
    {
        $tenantId = (string) $request->query('tenant');

        return $context->run($tenantId, function () use ($export, $storage) {
            $model = DataExport::query()->whereKey(strtolower($export))->first();
            if ($model === null || $model->status !== DataExport::COMPLETED || $model->file_path === null
                || ($model->expires_at !== null && $model->expires_at->isPast()) || ! $storage->ownsPath($model->file_path)) {
                throw new ApiException(404, 'not_found', 'Resource not found.');
            }
            $store = Store::query()->findOrFail($model->store_id);

            return $storage->privateDisk()->download($model->file_path, DataTransferPresenter::filename($model, $store), [
                'Content-Type' => 'text/csv; charset=utf-8',
                'Cache-Control' => 'private, no-store',
            ]);
        });
    }

    private function authorize(Store $store): void
    {
        Gate::authorize('view', $store);
        if (! Gate::allows('bulk-data')) {
            throw new ApiException(403, 'forbidden', 'Only the owner or an admin can import or export data.');
        }
    }
}
