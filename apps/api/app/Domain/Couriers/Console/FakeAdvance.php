<?php

declare(strict_types=1);

namespace App\Domain\Couriers\Console;

use App\Domain\Couriers\FakeShipmentAdvancer;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Console\Command;

/**
 * `couriers:fake-advance {shipment} {status} [--cod=]` (COURIERS_FAKE only; PHASE-5B §15): moves a fake parcel and
 * applies it through the webhook path (or a poll for RedX). Statuses: FakeShipmentAdvancer::STATUSES.
 */
class FakeAdvance extends Command
{
    protected $signature = 'couriers:fake-advance {shipment} {status} {--cod= : collected COD in paisa (delivered / partially_delivered)}';

    protected $description = 'Move a fake courier parcel to a new status (COURIERS_FAKE=true only).';

    public function handle(TenantContext $context, FakeShipmentAdvancer $advancer): int
    {
        if (! config('couriers.fake') || app()->environment('production')) {
            $this->error('COURIERS_FAKE is off.');

            return self::FAILURE;
        }
        $status = strtolower((string) $this->argument('status'));
        if (! in_array($status, FakeShipmentAdvancer::STATUSES, true)) {
            $this->error('Status must be one of: '.implode(', ', FakeShipmentAdvancer::STATUSES));

            return self::INVALID;
        }
        // cross-tenant: developer tool (fake couriers only) — find the shipment's tenant, then work inside it.
        $row = Shipment::withoutTenancy()->whereKey(strtolower((string) $this->argument('shipment')))->first(['id', 'tenant_id']);
        if ($row === null) {
            $this->error('Shipment not found.');

            return self::FAILURE;
        }
        $cod = $this->option('cod');
        $shipment = $context->run((string) $row->tenant_id, fn () => $advancer->advance(
            Shipment::query()->findOrFail($row->id), $status, $cod !== null ? (int) $cod : null,
        ));
        $this->info(sprintf('Shipment %s is now %s (%s).', $shipment->id, $shipment->status, $shipment->provider_status ?? '-'));

        return self::SUCCESS;
    }
}
