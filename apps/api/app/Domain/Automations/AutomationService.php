<?php

declare(strict_types=1);

namespace App\Domain\Automations;

use App\Domain\Automations\Messages\AutomationMessages;
use App\Domain\Automations\Models\Automation;
use App\Domain\Automations\Models\AutomationRun;
use App\Domain\Automations\Recipes\RecipeCatalogue;
use App\Domain\Billing\Feature;
use App\Domain\Billing\FeatureGate;
use App\Domain\Catalog\Models\Product;
use App\Domain\Coupons\Models\Coupon;
use App\Domain\Identity\Models\User;
use App\Domain\Marketing\CampaignAllowance;
use App\Domain\Marketing\Content\StoreBrand;
use App\Domain\Marketing\MarketingAddress;
use App\Domain\Marketing\Sending\CampaignMessenger;
use App\Domain\Marketing\Sending\CampaignSendFailed;
use App\Domain\Marketing\Sending\DevMessageSink;
use App\Domain\Marketing\UnsubscribeCodes;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Sms\Charging\SmsCharger;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Sms\SmsSender;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\Support\TenantCache;
use App\Domain\Tenancy\TenantContext;
use App\Domain\Themes\StoreThemeService;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

/**
 * Automation CRUD and the merchant side of the state machine (PHASE-8-6 §9.1, P86-17, P86-22). Transitions are a
 * row-locked read + write in one transaction. Audit (S139): automation.created|updated|enabled|disabled|deleted|test_sent.
 */
final class AutomationService
{
    public function __construct(
        private readonly AuditLogger $audit,
        private readonly TenantContext $context,
        private readonly CampaignMessenger $messenger,
    ) {}

    public function create(Store $store, string $recipe, ?User $user): Automation
    {
        $this->assertPlan();
        $definition = RecipeCatalogue::get($recipe);
        $language = (string) (StoreSetting::query()->where('store_id', $store->id)->value('sms_language') ?: 'bn');

        return DB::transaction(function () use ($store, $recipe, $definition, $language, $user) {
            if (Automation::query()->where('store_id', $store->id)->where('recipe', $recipe)->lockForUpdate()->exists()) {
                throw self::exists();
            }
            $automation = new Automation;
            $automation->store_id = $store->id;
            $automation->recipe = $recipe;
            $automation->name = $definition->name();
            $automation->status = Automation::DRAFT;
            $automation->settings = $definition->defaults($language === 'en' ? 'en' : 'bn');
            $automation->created_by = $user?->getKey();
            try {
                DB::transaction(fn () => $automation->save());
            } catch (QueryException $e) {
                // A concurrent create of the same recipe (UNIQUE(store_id, recipe)); anything else is a real error.
                if (Automation::query()->where('store_id', $store->id)->where('recipe', $recipe)->exists()) {
                    throw self::exists();
                }

                throw $e;
            }
            $this->audit->log('automation.created', $automation, ['recipe' => $recipe]);

            return $automation;
        });
    }

    /** @param array<string, mixed> $input {name?, settings?} */
    public function update(Store $store, Automation $automation, array $input, int $revision): Automation
    {
        return DB::transaction(function () use ($store, $automation, $input, $revision) {
            $locked = $this->lock($automation);
            if ($locked->revision !== $revision) {
                throw StoreThemeService::conflict();
            }
            $changed = [];
            if (array_key_exists('name', $input)) {
                $locked->name = trim((string) $input['name']);
                $changed[] = 'name';
            }
            if (array_key_exists('settings', $input)) {
                $locked->settings = $locked->recipeDefinition()->validate($store, $input['settings']);
                $changed[] = 'settings';
            }
            if ($locked->status === Automation::ON) {
                $this->assertPlan();
                $this->assertComplete($locked);
            }
            if ($locked->isDirty()) {
                $locked->revision++;
                $locked->save();
                $this->audit->log('automation.updated', $locked, ['fields' => $changed]);
            }

            return $locked;
        });
    }

    public function enable(Store $store, Automation $automation): Automation
    {
        $this->assertPlan();

        return DB::transaction(function () use ($store, $automation) {
            $locked = $this->lock($automation);
            if ($locked->status === Automation::ON) {
                return $locked;
            }
            // Re-validate the stored settings (coupons may have expired since) and require them complete.
            $locked->settings = $locked->recipeDefinition()->validate($store, (array) $locked->settings);
            $this->assertComplete($locked);
            $locked->status = Automation::ON;
            $locked->revision++;
            $locked->save();
            $this->audit->log('automation.enabled', $locked);

            return $locked;
        });
    }

    public function disable(Automation $automation): Automation
    {
        return DB::transaction(function () use ($automation) {
            $locked = $this->lock($automation);
            if ($locked->status !== Automation::ON) {
                return $locked;
            }
            $locked->status = Automation::OFF;
            $locked->revision++;
            $locked->save();
            // Waiting runs stop now; a running one stops at its next step check (automation_off).
            AutomationRun::query()->where('automation_id', $locked->id)->where('status', AutomationRun::WAITING)
                ->update(['status' => AutomationRun::STOPPED, 'outcome_reason' => 'automation_off', 'resume_at' => null, 'finished_at' => now(), 'updated_at' => now()]);
            $this->audit->log('automation.disabled', $locked);

            return $locked;
        });
    }

    public function delete(Automation $automation): void
    {
        DB::transaction(function () use ($automation) {
            $locked = $this->lock($automation);
            if ($locked->status !== Automation::DRAFT || AutomationRun::query()->where('automation_id', $locked->id)->exists()) {
                throw new ApiException(409, 'automation_not_draft', 'Only a draft that never ran can be deleted. Turn it off instead; nothing is deleted.');
            }
            $locked->delete();
            $this->audit->log('automation.deleted', $locked, ['recipe' => $locked->recipe]);
        });
    }

    /**
     * P86-22 "Send test": one step's message to the actor (verified phone / account email), sample merge values, a test
     * unsubscribe code; counts toward the shared allowance; 5 per hour per user; audited `automation.test_sent`.
     *
     * @return array{to_masked: string}
     */
    public function test(Store $store, Automation $automation, User $user, int $step): array
    {
        $tenant = $this->assertPlan();
        $recipe = $automation->recipeDefinition();
        $flowStep = $recipe->messageStep((array) $automation->settings, $step);
        if ($flowStep === null) {
            throw ValidationException::withMessages(['step' => ['This recipe has no such message step.']]);
        }
        $message = (array) $flowStep['message'];
        $channel = (string) $message['channel'];
        if (CampaignAllowance::planHasNone($tenant, $channel)) {
            CampaignAllowance::assertFits($tenant, $channel, 1);
        }
        $to = $channel === 'sms'
            ? ($user->phone_verified_at !== null ? MarketingAddress::normalize('sms', $user->phone) : null)
            : MarketingAddress::normalize('email', $user->email);
        if ($to === null) {
            throw ValidationException::withMessages(['step' => [$channel === 'sms' ? 'Verify your phone number in your account to get test SMS.' : 'Your account has no valid email address.']]);
        }
        $limiterKey = app(TenantCache::class)->key('automations-test:'.$user->getKey());
        $perHour = (int) config('automations.test_sends_per_hour', 5);
        if (RateLimiter::tooManyAttempts($limiterKey, $perHour)) {
            throw new ApiException(429, 'rate_limited', 'You can send 5 test messages an hour. Try again later.', null, RateLimiter::availableIn($limiterKey));
        }

        $brand = StoreBrand::of($store);
        $coupon = $flowStep['coupon_id'] !== null ? Coupon::query()->where('store_id', $store->id)->whereKey($flowStep['coupon_id'])->first() : null;
        $product = Product::query()->where('store_id', $store->id)->where('status', Product::ACTIVE)->orderByDesc('created_at')->first(['name', 'slug']);
        $code = UnsubscribeCodes::generate();
        $rendered = AutomationMessages::render(
            $message, $brand, (string) $user->name, $code, $coupon?->code ?? ($recipe->isRecovery() || $recipe->key() === 'vip_tag' ? 'COUPON' : null),
            ['name' => (string) ($product?->name ?? 'Product'), 'slug' => $product?->slug], 'SP-1001',
            $recipe->isRecovery() ? AutomationMessages::cartLink($brand, Str::random(10)) : null,
        );
        CampaignAllowance::assertFits($tenant, $channel, $rendered['parts']);
        RateLimiter::hit($limiterKey, 3600);

        // PHASE-8-9A §4.3: an SMS test is charged like the step (allowance, else credits) before the provider call.
        $message = null;
        $chargedFrom = null;
        $sender = null;
        if ($channel === 'sms') {
            $sender = SmsSender::for($store);
            [$message, $charge] = DB::transaction(function () use ($automation, $store, $to, $rendered, $sender) {
                $message = SmsMessage::query()->create([
                    'tenant_id' => $automation->tenant_id, 'store_id' => $store->id, 'to' => $to, 'purpose' => 'automation',
                    'template' => 'automation:'.$automation->id.':test', 'status' => SmsMessage::QUEUED, 'sender_id' => $sender,
                    'reference_type' => 'automation', 'reference_id' => $automation->id,
                ]);

                return [$message, app(SmsCharger::class)->charge($message, $rendered['text'])];
            });
            if ($charge->skipped()) {
                CampaignAllowance::assertFits($tenant, $channel, $rendered['parts']);

                throw SmsCharger::exhausted($charge);
            }
            $chargedFrom = $charge->from;
        }
        $error = null;
        $providerId = null;
        try {
            $providerId = $channel === 'sms'
                ? $this->messenger->sms($store->id, $to, $rendered['text'], $sender)
                : $this->messenger->email($brand, $to, (array) $rendered['email']);
        } catch (CampaignSendFailed $e) {
            $error = $e->errorCode;
            report($e);
        }
        if ($message !== null) {
            if ($error === null) {
                $message->markSent($providerId);
            } else {
                $message->markFailed($error);
                app(SmsCharger::class)->refund($message);
            }
        }
        if ($error !== null) {
            throw new ApiException(502, 'provider_error', $channel === 'sms' ? 'The SMS provider could not send the test message. Try again in a moment.' : 'The email could not be sent. Try again in a moment.');
        }
        $masked = MarketingAddress::mask($channel, $to);
        $this->audit->log('automation.test_sent', $automation, ['channel' => $channel, 'parts' => $rendered['parts'], 'charged_from' => $chargedFrom, 'step' => $step, 'store_id' => $store->id, 'to_masked' => $masked, 'code_hash' => UnsubscribeCodes::hash($code)]);
        DevMessageSink::record($store->id, ['channel' => $channel, 'to' => $to, 'subject' => $rendered['subject'], 'text' => $rendered['text'],
            'unsubscribe_url' => $rendered['unsubscribe_url'], 'campaign_id' => null, 'is_test' => true, 'automation_id' => $automation->id]);

        return ['to_masked' => $masked];
    }

    /** 402 feature_not_in_plan unless the plan has `sms_automation` (P86-17). */
    public function assertPlan(): Tenant
    {
        $tenant = $this->context->tenant() ?? throw new ApiException(403, 'forbidden', 'You do not have permission to do this.');
        FeatureGate::assertAllows($tenant, Feature::SmsAutomation);

        return $tenant;
    }

    private function assertComplete(Automation $automation): void
    {
        $missing = $automation->recipeDefinition()->incomplete((array) $automation->settings);
        if ($missing !== []) {
            $fields = array_map(fn (string $f) => 'settings.'.$f, $missing);

            throw new ApiException(422, 'automation_incomplete', 'Finish the recipe settings before turning it on.', ['fields' => $fields]);
        }
    }

    private function lock(Automation $automation): Automation
    {
        return Automation::query()->whereKey($automation->id)->lockForUpdate()->firstOrFail();
    }

    private static function exists(): ApiException
    {
        return new ApiException(409, 'automation_exists', 'Your store already has this automation.');
    }
}
