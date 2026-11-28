<?php

declare(strict_types=1);

namespace App\Domain\Feeds\Http\Controllers;

use App\Domain\Feeds\FeedOauth;
use App\Domain\Integrations\IntegrationProvider;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

/**
 * PHASE-8-9D §7.1 (S339): the public OAuth callback (no session, no tenant header; limiter `oauth-callback`). A missing
 * or tampered state is a plain 400 page; everything else 303s to the merchant app (`?oauth=success` or
 * `?oauth=error&reason=…`). Never renders provider data.
 */
final class OauthCallbackController
{
    public function __invoke(Request $request, string $provider, FeedOauth $oauth): Response|RedirectResponse
    {
        IntegrationProvider::assertIn($provider, IntegrationProvider::FEEDS);
        $state = FeedOauth::decode($request->query('state'));
        if ($state === null) {
            return new Response('<!doctype html><title>Store Plix</title><p>This sign-in link is invalid or has expired. Go back to Store Plix and try again.</p>', 400,
                ['Content-Type' => 'text/html; charset=utf-8', 'Cache-Control' => 'no-store', 'Referrer-Policy' => 'no-referrer']);
        }
        $code = $request->query('code');
        $error = $request->query('error');
        $location = $oauth->callback($provider, $state, is_string($code) ? $code : null, is_string($error) ? mb_substr($error, 0, 64) : null);

        return new RedirectResponse($location, 303, ['Cache-Control' => 'no-store', 'Referrer-Policy' => 'no-referrer']);
    }
}
