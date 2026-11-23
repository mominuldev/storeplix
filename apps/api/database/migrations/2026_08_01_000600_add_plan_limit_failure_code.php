<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;

/**
 * PHASE-7-CONTRACT §5.1 000600 / §2.3: the new DomainFailureCode `plan_limit`. `store_domains.failure_code` is a
 * free varchar(48) without a CHECK (Phase 6 000100), so nothing needs widening; the migration documents the decision
 * and keeps the numbering of the contract.
 */
return new class extends Migration
{
    public function up(): void
    {
        // No CHECK on store_domains.failure_code: the value list lives in App\Domain\Domains\DomainFailureCode.
    }

    public function down(): void {}
};
