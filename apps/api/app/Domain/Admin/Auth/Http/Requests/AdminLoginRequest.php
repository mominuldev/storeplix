<?php

declare(strict_types=1);

namespace App\Domain\Admin\Auth\Http\Requests;

use App\Domain\Identity\Http\Requests\LoginRequest;

/** POST /admin/auth/login (PHASE-8-1 §3.1): same input rules as the merchant sign-in. */
class AdminLoginRequest extends LoginRequest {}
