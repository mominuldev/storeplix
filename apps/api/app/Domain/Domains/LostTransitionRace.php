<?php

declare(strict_types=1);

namespace App\Domain\Domains;

use RuntimeException;

/** @internal rolls back a transition whose conditional update matched no row (someone else moved the domain) */
final class LostTransitionRace extends RuntimeException {}
