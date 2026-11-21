<?php

namespace App\Domain\Identity\Otp;

enum OtpPurpose: string
{
    case VerifyPhone = 'verify_phone';
    case Login = 'login';
    case ResetPassword = 'reset_password';
}
