<?php

declare(strict_types=1);

namespace App\Domain\Integrations\Settings;

use App\Domain\Integrations\PublicEndpointGuard;
use App\Domain\Shared\Http\ApiException;
use InvalidArgumentException;

/**
 * PHASE-8-9D §4.3, P89D-9: Google Tag Manager **server container** only. Events are forwarded from the API to the
 * merchant's tagging server as GA4 Measurement Protocol requests. There is no web-container field: a `gtm.js` URL is
 * refused (rule 7). The tagging server URL passes PublicEndpointGuard on save (422 `integration_endpoint_blocked`).
 */
final class GtmServerSettings extends ProviderSettings
{
    public const EVENTS = ['page_view', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase', 'refund'];

    public static function defaults(): array
    {
        return [
            'container_id' => null, 'tagging_server_url' => null, 'measurement_id' => null, 'events' => self::EVENTS,
            'send_customer_data' => true, 'wait_for_consent' => false, 'purchase_trigger' => 'order_confirmed', 'include_delivery_charge' => false,
        ];
    }

    public static function writable(): array
    {
        return array_keys(self::defaults());
    }

    public static function idFields(): array
    {
        return [
            'container_id' => ['/^GTM-[A-Z0-9]{4,10}$/', 'Container ID', true, true],
            'measurement_id' => ['/^G-[A-Z0-9]{4,12}$/', 'Measurement ID', true, true],
        ];
    }

    protected static function rules(): array
    {
        return self::trackingRules() + [
            'tagging_server_url' => ['required', 'string', 'max:300'],
            'events' => ['required', 'array', 'min:1', 'max:6'],
            'events.*' => ['string', 'distinct', 'in:'.implode(',', self::EVENTS)],
        ];
    }

    protected static function normalize(array $settings): array
    {
        $url = rtrim(trim((string) $settings['tagging_server_url']), '/');
        $host = strtolower((string) parse_url($url, PHP_URL_HOST));
        if ($host === 'googletagmanager.com' || str_ends_with($host, '.googletagmanager.com') || str_contains(strtolower($url), 'gtm.js')) {
            throw new ApiException(422, 'integration_id_invalid', "Web containers aren't supported. Use a server container's tagging server URL.", ['field' => 'settings.tagging_server_url']);
        }
        try {
            PublicEndpointGuard::assertAcceptable($url);
        } catch (InvalidArgumentException $e) {
            throw new ApiException(422, 'integration_endpoint_blocked', 'This tagging server address is not allowed: '.$e->getMessage(), ['field' => 'settings.tagging_server_url']);
        }
        $parts = parse_url($url);
        if (isset($parts['query']) || isset($parts['fragment'])) {
            throw new ApiException(422, 'integration_endpoint_blocked', 'Use the tagging server address without ? or #.', ['field' => 'settings.tagging_server_url']);
        }
        $settings['tagging_server_url'] = $url;
        $settings['events'] = array_values(array_filter(self::EVENTS, fn (string $e) => in_array($e, (array) $settings['events'], true)));

        return $settings;
    }
}
