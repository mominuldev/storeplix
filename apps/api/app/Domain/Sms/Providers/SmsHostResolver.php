<?php

declare(strict_types=1);

namespace App\Domain\Sms\Providers;

use App\Domain\Integrations\PublicHostResolver;

/** DNS lookup for provider endpoints (S224 pin). Bound in the container so tests can answer without the network. */
class SmsHostResolver extends PublicHostResolver {}
