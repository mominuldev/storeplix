<?php

declare(strict_types=1);

namespace App\Domain\Domains;

/** PHASE-6-CONTRACT §2.4: stable failure codes (DomainFailureCode in @storeplix/types). */
enum DomainFailureCode: string
{
    case TxtMissing = 'txt_missing';
    case TxtMismatch = 'txt_mismatch';
    case CnameMissing = 'cname_missing';
    case CnameMismatch = 'cname_mismatch';
    case DnsError = 'dns_error';
    case VerificationTimeout = 'verification_timeout';
    case ProviderError = 'provider_error';
    case ProviderBlocked = 'provider_blocked';
    case ProviderMoved = 'provider_moved';
    case SslValidationFailed = 'ssl_validation_failed';
    case SslTimeout = 'ssl_timeout';
    case SslLost = 'ssl_lost';
    case Suspended = 'suspended';

    /** Merchant-facing default text (failure_message); the dashboard maps the code to its own copy (§8). */
    public function message(): string
    {
        return match ($this) {
            self::TxtMissing => 'We could not find the TXT record.',
            self::TxtMismatch => 'The TXT record has a different value.',
            self::CnameMissing => 'We could not find the CNAME record.',
            self::CnameMismatch => 'The CNAME record points somewhere else.',
            self::DnsError => 'DNS lookups did not answer. We will try again.',
            self::VerificationTimeout => 'The DNS records were not found within 72 hours.',
            self::ProviderError => 'We could not set up the certificate yet. We will try again.',
            self::ProviderBlocked => 'This hostname was blocked by our certificate provider.',
            self::ProviderMoved => 'This hostname no longer points to us.',
            self::SslValidationFailed => 'The certificate could not be validated.',
            self::SslTimeout => 'The certificate was not issued within 24 hours.',
            self::SslLost => 'The certificate for this domain is no longer active.',
            self::Suspended => 'This domain was suspended by Store Plix.',
        };
    }
}
