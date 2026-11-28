<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-9B §3.1, §6 (P89B-11 – P89B-15): the nine platform SMS types (on/off switch per type, seeded on; locked code
 * types are forced on in code) and the custom bn/en bodies of the five editable types (only custom rows; defaults in
 * resources/sms/platform). Platform tables: app role SELECT only, writes on the admin connection.
 */
return new class extends Migration
{
    private const TYPES = ['welcome', 'phone_verification', 'invoice_issued', 'payment_received', 'payment_due', 'plan_expiring',
        'sign_in_code', 'password_reset_code', 'broadcast'];

    private const EDITABLE = ['welcome', 'invoice_issued', 'payment_received', 'payment_due', 'plan_expiring'];

    public function up(): void
    {
        Schema::create('platform_sms_message_types', function (Blueprint $table) {
            $table->string('type', 24)->primary();
            $table->boolean('enabled')->default(true);
            $table->foreignUlid('updated_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampTz('updated_at')->nullable();
        });

        Schema::create('platform_sms_templates', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->string('type', 24);
            $table->char('language', 2);
            $table->text('body');
            $table->integer('revision')->default(1);
            $table->foreignUlid('updated_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampsTz();

            $table->unique(['type', 'language']);
        });

        $now = now();
        DB::table('platform_sms_message_types')->insert(array_map(fn (string $t) => ['type' => $t, 'enabled' => true, 'updated_at' => $now], self::TYPES));

        $db = DB::connection();
        if ($db->getDriverName() === 'pgsql') {
            $in = fn (array $list) => "'".implode("','", $list)."'";
            foreach ([
                'platform_sms_message_types ADD CONSTRAINT platform_sms_message_types_type_check CHECK (type IN ('.$in(self::TYPES).'))',
                'platform_sms_templates ADD CONSTRAINT platform_sms_templates_type_check CHECK (type IN ('.$in(self::EDITABLE).'))',
                "platform_sms_templates ADD CONSTRAINT platform_sms_templates_language_check CHECK (language IN ('bn','en'))",
                'platform_sms_templates ADD CONSTRAINT platform_sms_templates_body_check CHECK (char_length(body) BETWEEN 1 AND 480)',
                'platform_sms_templates ADD CONSTRAINT platform_sms_templates_revision_check CHECK (revision >= 1)',
            ] as $statement) {
                $db->statement("ALTER TABLE {$statement}");
            }
            if (RlsPolicies::roleExists($db, RlsPolicies::APP_ROLE)) {
                foreach (['platform_sms_message_types', 'platform_sms_templates'] as $table) {
                    $db->statement("REVOKE ALL ON {$table} FROM ".RlsPolicies::APP_ROLE);
                    $db->statement("GRANT SELECT ON {$table} TO ".RlsPolicies::APP_ROLE);
                }
            }
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('platform_sms_templates');
        Schema::dropIfExists('platform_sms_message_types');
    }
};
