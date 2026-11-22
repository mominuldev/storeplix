<?php

declare(strict_types=1);

namespace App\Domain\Couriers\Drivers;

use App\Domain\Couriers\Models\CourierAccount;
use App\Domain\Integrations\SafeHttpClient;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Shared\Support\Money;
use App\Domain\Tenancy\Support\TenantCache;
use Carbon\CarbonImmutable;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Http\Client\Response;
use Throwable;

/**
 * Shared plumbing of the HTTP courier drivers: SafeHttpClient with the config base URL for the account's mode,
 * 10 s connect / 30 s total, no redirects; transport errors, 429 and 5xx → provider_unavailable; log lines with the
 * provider, action, account/shipment ids and HTTP status only.
 */
abstract class HttpCourierDriver implements CourierDriver
{
    public function __construct(
        protected readonly SafeHttpClient $http,
        protected readonly TenantCache $cache,
    ) {}

    abstract protected function provider(): string;

    public function normalise(string $rawStatus, ?Shipment $shipment = null): NormalisedStatus
    {
        return static::statusMap()[strtolower(trim($rawStatus))] ?? NormalisedStatus::unknown();
    }

    /** Default: one booking per request (Pathao, RedX). */
    public function bookBulk(CourierAccount $account, array $requests): array
    {
        $out = [];
        foreach ($requests as $key => $request) {
            $shipment = new Shipment;
            $shipment->id = $request->invoice;
            try {
                $out[$key] = $this->book($shipment, $account, $request);
            } catch (CourierException $e) {
                $out[$key] = $e;
            }
        }

        return $out;
    }

    public function areas(CourierAccount $account, string $level, ?string $parentId): array
    {
        return [];
    }

    public function pickupStores(CourierAccount $account): array
    {
        return [];
    }

    public function cancel(Shipment $shipment, CourierAccount $account): void
    {
        throw new CourierException(CourierException::CANCEL_UNSUPPORTED, 'This courier has no cancel API.');
    }

    protected function client(CourierAccount $account): PendingRequest
    {
        $base = $account->baseUrl() ?? throw new CourierException(CourierException::NOT_CONNECTED, "No {$this->provider()} base URL for mode {$account->mode}.");

        return $this->http->to($base)
            ->connectTimeout((int) config('couriers.http.connect_timeout', 10))
            ->timeout((int) config('couriers.http.timeout', 30));
    }

    /**
     * One HTTP call. Throws provider_unavailable on transport errors, 429 and 5xx; other statuses are returned.
     *
     * @param  array<string, mixed>  $body
     * @param  array<string, scalar|null>  $ids
     */
    protected function send(PendingRequest $request, string $method, string $path, array $body, string $action, CourierAccount $account, array $ids = []): Response
    {
        $ids = ['account_id' => $account->id] + $ids;
        try {
            $response = match ($method) {
                'GET' => $request->get($path, $body === [] ? null : $body),
                'POST' => $request->post($path, $body),
                'PUT' => $request->put($path, $body),
                'DELETE' => $request->delete($path, $body),
            };
        } catch (ConnectionException) {
            SafeHttpClient::log($this->provider(), $action, null, $ids);
            throw new CourierException(CourierException::PROVIDER_UNAVAILABLE, "{$this->provider()} {$action} timed out.");
        }
        SafeHttpClient::log($this->provider(), $action, $response->status(), $ids);
        if ($response->serverError() || $response->status() === 429) {
            throw new CourierException(CourierException::PROVIDER_UNAVAILABLE, "{$this->provider()} {$action} returned HTTP {$response->status()}.");
        }

        return $response;
    }

    /** @return array<array-key, mixed> */
    protected static function json(Response $response): array
    {
        try {
            $data = $response->json();
        } catch (Throwable) {
            return [];
        }

        return is_array($data) ? $data : [];
    }

    /** Taka (number or string) → paisa; null when absent or not a valid amount. Never floats (string/bcmath). */
    protected static function paisa(mixed $taka): ?int
    {
        if (is_int($taka)) {
            return $taka * 100;
        }
        if (is_float($taka)) {
            $taka = number_format($taka, 2, '.', '');
        }

        return Money::tryFromDecimal(is_string($taka) ? trim($taka) : $taka);
    }

    /** Paisa → whole taka when whole ("1770"), else "1770.50": couriers that take a numeric string/number. */
    protected static function taka(int $paisa): string
    {
        return $paisa % 100 === 0 ? (string) intdiv($paisa, 100) : Money::toDecimal($paisa);
    }

    protected static function time(mixed $value): CarbonImmutable
    {
        if (is_string($value) && trim($value) !== '') {
            try {
                return CarbonImmutable::parse($value, 'Asia/Dhaka')->utc();
            } catch (Throwable) {
                // fall through
            }
        }
        if (is_int($value) && $value > 0) {
            return CarbonImmutable::createFromTimestampUTC($value);
        }

        return CarbonImmutable::now()->startOfSecond();
    }

    /** First non-empty string among nested keys ("a.b"). */
    protected static function str(array $data, string ...$paths): ?string
    {
        foreach ($paths as $path) {
            $value = data_get($data, $path);
            if (is_int($value)) {
                $value = (string) $value;
            }
            if (is_string($value) && trim($value) !== '') {
                return trim($value);
            }
        }

        return null;
    }

    /** First validation message of a courier 4xx body (Laravel-style `errors` or `message`), sanitised. */
    protected static function rejection(array $body, string $fallback): CourierException
    {
        $message = null;
        $field = null;
        $errors = $body['errors'] ?? $body['error'] ?? null;
        if (is_array($errors)) {
            foreach ($errors as $key => $value) {
                $message = is_array($value) ? (string) (array_values($value)[0] ?? '') : (string) $value;
                $field = is_string($key) ? $key : null;
                break;
            }
        }
        $message = ($message !== null && $message !== '') ? $message : (is_string($body['message'] ?? null) ? $body['message'] : $fallback);

        return new CourierException(CourierException::COURIER_REJECTED, CourierException::sanitise($message), static::ourField($field));
    }

    /** Courier field name → our BookShipmentInput field (for 422 details). Null when unknown. */
    protected static function ourField(?string $courierField): ?string
    {
        if ($courierField === null) {
            return null;
        }

        return match (true) {
            str_contains($courierField, 'phone') => 'recipient_phone',
            str_contains($courierField, 'weight') => 'weight_grams',
            str_contains($courierField, 'city'), str_contains($courierField, 'zone'), str_contains($courierField, 'area') => 'area',
            str_contains($courierField, 'address') => 'recipient_address',
            str_contains($courierField, 'cod'), str_contains($courierField, 'collect') => 'cod_amount',
            str_contains($courierField, 'description') => 'item_description',
            str_contains($courierField, 'note'), str_contains($courierField, 'instruction') => 'note',
            str_contains($courierField, 'store') => 'pickup_store',
            default => null,
        };
    }

    /** Header lookup in any case; array values (Symfony style) → the first. */
    protected static function header(array $headers, string $name): ?string
    {
        foreach ($headers as $key => $value) {
            if (strtolower((string) $key) === strtolower($name)) {
                $value = is_array($value) ? ($value[0] ?? null) : $value;

                return is_string($value) ? $value : null;
            }
        }

        return null;
    }

    /** +8801XXXXXXXXX / 8801… → 01XXXXXXXXX (Steadfast wants 11 digits). */
    public static function localPhone(string $phone): string
    {
        $digits = (string) preg_replace('/\D+/', '', $phone);
        if (str_starts_with($digits, '880')) {
            $digits = substr($digits, 2);
        }

        return $digits;
    }

    protected function cacheKey(CourierAccount $account, string $suffix): string
    {
        $fingerprint = substr(hash_hmac('sha256', $account->mode.'|'.json_encode($account->credentials), (string) config('app.key')), 0, 16);

        return "couriers:{$this->provider()}:{$account->id}:{$fingerprint}:{$suffix}";
    }
}
