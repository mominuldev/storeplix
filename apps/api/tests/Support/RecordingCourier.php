<?php

declare(strict_types=1);

namespace Tests\Support;

use App\Domain\Couriers\Drivers\BookingRequest;
use App\Domain\Couriers\Drivers\BookingResult;
use App\Domain\Couriers\Drivers\CourierDriver;
use App\Domain\Couriers\Drivers\CredentialCheck;
use App\Domain\Couriers\Drivers\FakeCourier;
use App\Domain\Couriers\Drivers\NormalisedStatus;
use App\Domain\Couriers\Drivers\StatusUpdate;
use App\Domain\Couriers\Drivers\WebhookEventData;
use App\Domain\Couriers\Models\CourierAccount;
use App\Domain\Orders\Models\Shipment;

/** Test double: a FakeCourier that records calls (`calls` = list of [method, count/arg]). Bind it over a real driver class. */
final class RecordingCourier implements CourierDriver
{
    /** @var list<array{0: string, 1: mixed}> */
    public array $calls = [];

    /** @var (callable(string, array<int, mixed>): mixed)|null overrides a call when it returns non-null */
    public $override = null;

    public function __construct(public readonly FakeCourier $inner) {}

    private function call(string $method, array $args): mixed
    {
        $this->calls[] = [$method, $method === 'bookBulk' ? count($args[1]) : null];
        if ($this->override !== null) {
            $result = ($this->override)($method, $args);
            if ($result !== null) {
                return $result;
            }
        }

        return $this->inner->{$method}(...$args);
    }

    public function count(string $method): int
    {
        return count(array_filter($this->calls, fn ($c) => $c[0] === $method));
    }

    public function checkCredentials(CourierAccount $account): CredentialCheck
    {
        return $this->call(__FUNCTION__, [$account]);
    }

    public function book(Shipment $shipment, CourierAccount $account, BookingRequest $request): BookingResult
    {
        return $this->call(__FUNCTION__, [$shipment, $account, $request]);
    }

    public function bookBulk(CourierAccount $account, array $requests): array
    {
        return $this->call(__FUNCTION__, [$account, $requests]);
    }

    public function status(Shipment $shipment, CourierAccount $account): StatusUpdate
    {
        return $this->call(__FUNCTION__, [$shipment, $account]);
    }

    public function findByInvoice(string $invoice, CourierAccount $account): ?BookingResult
    {
        return $this->call(__FUNCTION__, [$invoice, $account]);
    }

    public function cancel(Shipment $shipment, CourierAccount $account): void
    {
        $this->call(__FUNCTION__, [$shipment, $account]);
    }

    public function parseWebhook(array $payload, array $headers, CourierAccount $account): ?WebhookEventData
    {
        return $this->call(__FUNCTION__, [$payload, $headers, $account]);
    }

    public function supportsWebhooks(): bool
    {
        return $this->inner->supportsWebhooks();
    }

    public function areas(CourierAccount $account, string $level, ?string $parentId): array
    {
        return $this->inner->areas($account, $level, $parentId);
    }

    public function pickupStores(CourierAccount $account): array
    {
        return $this->inner->pickupStores($account);
    }

    public function capabilities(): array
    {
        return $this->inner->capabilities();
    }

    public static function statusMap(): array
    {
        return FakeCourier::statusMap();
    }

    public function normalise(string $rawStatus, ?Shipment $shipment = null): NormalisedStatus
    {
        return $this->inner->normalise($rawStatus, $shipment);
    }
}
