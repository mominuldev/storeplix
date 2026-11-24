<?php

declare(strict_types=1);

namespace App\Domain\Developer\Webhooks\Sending;

use App\Domain\Shared\Http\ApiException;

/** §4.3: rendered as 422 `webhook_url_not_allowed` on save; recorded as `url_not_allowed` at send time. */
final class UrlNotAllowed extends ApiException
{
    public function __construct(string $reason)
    {
        parent::__construct(422, 'webhook_url_not_allowed', $reason, ['url' => [$reason]]);
    }
}
