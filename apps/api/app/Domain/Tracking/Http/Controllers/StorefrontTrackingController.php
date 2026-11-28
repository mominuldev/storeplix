<?php

declare(strict_types=1);

namespace App\Domain\Tracking\Http\Controllers;

use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Services\StorefrontContext;
use App\Domain\Tracking\TrackingBeacon;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

/**
 * PHASE-8-9D §6.2 (S335): `POST /storefront/tracking/events`, server-to-server from the storefront beacon route.
 * Storefront key + host (middleware), live stores only (draft → 404), ≤ 20 events, limiter `tracking-beacon`. Browser
 * amounts are not part of the schema at all; the API prices from the catalogue. Always 202 with no body.
 */
final class StorefrontTrackingController
{
    public function __invoke(Request $request): Response
    {
        $ctx = StorefrontContext::from($request);
        if (! $ctx->isLive() || $ctx->preview) {
            throw new ApiException(404, 'store_not_found', 'No store is registered for this host.');
        }
        $max = (int) config('tracking.beacon_max_events', 20);
        $input = $request->validate([
            'events' => ['required', 'array', 'min:1', "max:{$max}"],
            'events.*.event_id' => ['required', 'string', 'regex:/^[0-9A-Za-z_.\-]{8,64}$/'],
            'events.*.name' => ['required', 'string', 'in:page_view,view_item,add_to_cart,begin_checkout'],
            'events.*.occurred_at' => ['required', 'string', 'max:40'],
            'events.*.page_path' => ['required', 'string', 'max:300', 'regex:/^\//'],
            'events.*.variant_id' => ['sometimes', 'nullable', 'string', 'regex:/^[0-9A-Za-z]{26}$/'],
            'events.*.product_id' => ['sometimes', 'nullable', 'string', 'regex:/^[0-9A-Za-z]{26}$/'],
            'events.*.quantity' => ['sometimes', 'nullable', 'integer', 'min:1', 'max:999'],
            'context' => ['required', 'array'],
            'context.consent' => ['required', 'string', 'in:granted,denied,not_required'],
            'context.fbp' => ['sometimes', 'nullable', 'string', 'max:200'],
            'context.fbc' => ['sometimes', 'nullable', 'string', 'max:500'],
            'context.ttp' => ['sometimes', 'nullable', 'string', 'max:200'],
            'context.ttclid' => ['sometimes', 'nullable', 'string', 'max:500'],
            'context.ga_client_id' => ['sometimes', 'nullable', 'string', 'max:100'],
            'context.ga_session_id' => ['sometimes', 'nullable', 'string', 'max:100'],
            'context.user_agent' => ['sometimes', 'nullable', 'string', 'max:1000'],
            'context.test_token' => ['sometimes', 'nullable', 'string', 'max:400'],
        ]);
        TrackingBeacon::handle($ctx->store, array_values($input['events']), (array) $input['context'], $ctx->clientIp);

        return new Response('', 202, ['Cache-Control' => 'private, no-store']);
    }
}
