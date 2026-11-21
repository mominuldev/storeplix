<?php

namespace App\Domain\Identity\Otp;

use App\Domain\Shared\Http\ApiException;

class OtpRateLimited extends ApiException
{
    public function __construct(int $retryAfter)
    {
        parent::__construct(429, 'otp_rate_limited', 'Too many code requests. Please wait before trying again.', null, max(1, $retryAfter));
    }
}
