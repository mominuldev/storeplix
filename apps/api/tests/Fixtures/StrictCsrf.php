<?php

namespace Tests\Fixtures;

use Illuminate\Foundation\Http\Middleware\ValidateCsrfToken;

/** The framework skips CSRF checks while running unit tests; CSRF tests use this strict variant. */
class StrictCsrf extends ValidateCsrfToken
{
    protected function runningUnitTests()
    {
        return false;
    }
}
