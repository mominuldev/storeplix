<?php

declare(strict_types=1);

namespace App\Domain\Automations\Engine;

use App\Domain\Automations\Mail\LowStockMail;
use App\Domain\Automations\Messages\AutomationMessages;
use App\Domain\Automations\Models\Automation;
use App\Domain\Automations\Models\AutomationRun;
use App\Domain\Automations\Models\AutomationRunStep;
use App\Domain\Automations\Recipes\Recipe;
use App\Domain\Billing\Feature;
use App\Domain\Billing\FeatureGate;
use App\Domain\Coupons\Models\Coupon;
use App\Domain\Customers\CustomerService;
use App\Domain\Customers\Models\Customer;
use App\Domain\Marketing\CampaignAllowance;
use App\Domain\Marketing\Content\StoreBrand;
use App\Domain\Marketing\QuietHours;
use App\Domain\Marketing\Sending\CampaignMessenger;
use App\Domain\Marketing\Sending\CampaignSendFailed;
use App\Domain\Marketing\Sending\DevMessageSink;
use App\Domain\Marketing\Suppressions;
use App\Domain\Marketing\UnsubscribeCodes;
use App\Domain\Orders\Models\Order;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use Throwable;

/**
 * The automation engine (PHASE-8-6 §4.3, §6). Runs inside the tenant (TenantAware jobs, console per tenant).
 *
 * start(): plan + status check (no run when not in plan, P86-17) → subject → conditions → dedupe key → run INSERT …
 * ON CONFLICT DO NOTHING (P86-4: a duplicate event, a retried job or two workers produce one run) → skipped or process.
 * process(): executes the recipe flow from `next_step`. Before every step: automation `on`, plan, exit conditions
 * (P86-14). Waits and quiet hours put the run in `waiting` with `resume_at` (resumed by `automations:resume-due`, whose
 * conditional UPDATE `waiting → running` hands each run to one worker). Every executed action gets one step row,
 * UNIQUE(run_id, step_index): a message step is inserted as `sending` before the provider call (P86-5), so a step is
 * never executed twice; `unknown` is never retried.
 */
final class AutomationEngine
{
    public function __construct(
        private readonly CampaignMessenger $messenger,
        private readonly TenantContext $context,
    ) {}

    /** EvaluateAutomation. Returns the run id, or null when no run was created (duplicate, off, not in plan). */
    public function start(string $automationId, string $trigger, string $subjectType, string $subjectId): ?string
    {
        $automation = Automation::query()->find($automationId);
        if ($automation === null || ! $automation->isOn() || $automation->recipeDefinition()->trigger() !== $trigger || ! $this->planAllows()) {
            return null;
        }
        $store = Store::query()->find($automation->store_id);
        if ($store === null) {
            return null;
        }
        $recipe = $automation->recipeDefinition();
        $settings = (array) $automation->settings;
        $subject = Subject::load($store, $subjectType, $subjectId);
        $now = now();

        if ($subject === null) {
            $id = $this->insertRun($automation, $trigger, $subjectType.':'.strtolower($subjectId), $subjectType, $subjectId, null, null, [], $now, null);
            if ($id !== null) {
                $this->finish($id, AutomationRun::SKIPPED, 'subject_missing');
            }

            return $id;
        }

        $evaluation = Conditions::evaluate($recipe->conditions($settings), $subject);
        $dedupe = $recipe->dedupeKey($subject, $settings, $evaluation['passed'], $store);
        if ($recipe->isRecovery() && $subject->phone !== null) {
            // P86-13: one flow per (store, phone) per exit window — an open run of this contact owns the key.
            $open = AutomationRun::query()->where('automation_id', $automation->id)->where('contact_address', $subject->phone)
                ->whereIn('status', AutomationRun::OPEN)->where('window_ends_at', '>', $now)->value('dedupe_key');
            $dedupe = $open ?? $dedupe;
        }
        $window = $recipe->isRecovery() ? $now->copy()->addDays((int) ($settings['exit_days'] ?? 3)) : null;
        $contact = $recipe->isRecovery() ? $subject->phone : $this->customerAddress($subject, $recipe, $settings);
        $id = $this->insertRun($automation, $trigger, $dedupe, $subject->type, $subject->id, $subject->customer?->id, $contact, $subject->context, $now, $window);
        if ($id === null) {
            return null;
        }
        Automation::query()->whereKey($automation->id)->update(['last_run_at' => $now]);
        if (! $evaluation['passed']) {
            $this->finish($id, AutomationRun::SKIPPED, 'conditions_not_met', ['conditions' => self::conditionDetail($evaluation['results'])]);

            return $id;
        }
        $this->process($id);

        return $id;
    }

    /** Continues a run that `resume-due` (or the reaper) moved to `running`. */
    public function resume(string $runId): void
    {
        $this->process($runId);
    }

    public function process(string $runId): void
    {
        $run = AutomationRun::query()->find($runId);
        if ($run === null || $run->status !== AutomationRun::RUNNING) {
            return;
        }
        try {
            $this->run($run);
        } catch (Throwable $e) {
            report($e);
            $this->finish($run->id, AutomationRun::FAILED, 'error');
        }
    }

    private function run(AutomationRun $run): void
    {
        $automation = Automation::query()->find($run->automation_id);
        $store = Store::query()->find($run->store_id);
        if ($automation === null || $store === null) {
            $this->finish($run->id, AutomationRun::FAILED, 'error');

            return;
        }
        $recipe = $automation->recipeDefinition();
        $settings = (array) $automation->settings;
        $flow = $recipe->flow($settings);
        $subject = Subject::load($store, $run->subject_type, $run->subject_id);
        $timezone = (string) ($store->timezone ?: 'Asia/Dhaka');
        $i = $run->next_step;

        while ($i < count($flow)) {
            $step = $flow[$i];
            $exitWait = $step['kind'] === 'wait' && ($step['until'] ?? null) === 'window';
            if (($stop = $this->exitReason($run, $automation, $recipe, ! $exitWait)) !== null) {
                $this->finish($run->id, AutomationRun::STOPPED, $stop);

                return;
            }
            if ($subject === null) {
                $this->finish($run->id, AutomationRun::FAILED, 'error');

                return;
            }

            if ($step['kind'] === 'wait') {
                $until = match (true) {
                    $exitWait => $run->window_ends_at,
                    ($step['from'] ?? 'now') === 'start' => $run->started_at->copy()->addHours((int) $step['hours']),
                    default => now()->addHours((int) $step['hours']),
                };
                if ($until !== null && $until->gt(now())) {
                    $this->wait($run, $i + 1, $until);

                    return;
                }
                $i = $this->advance($run, $i + 1);

                continue;
            }

            if ($step['kind'] === 'send_message') {
                if (! $step['enabled']) {
                    $i = $this->advance($run, $i + 1);

                    continue;
                }
                if (QuietHours::isQuiet(now(), $timezone)) {
                    // P86-9: wait until 09:00 store time; exit conditions are re-checked on resume.
                    $this->wait($run, $i, QuietHours::allowedFrom(now(), $timezone));

                    return;
                }
                $firstMessage = ! AutomationRunStep::query()->where('run_id', $run->id)->where('status', AutomationRunStep::DONE)->exists();
                $outcome = $this->sendMessage($run, $automation, $recipe, $store, $subject, $step);
                $i = $this->advance($run, $i + 1);
                if ($outcome !== null && $outcome['status'] === AutomationRunStep::SKIPPED) {
                    if ($outcome['reason'] === 'opted_out' && $recipe->isRecovery()) {
                        $this->finish($run->id, AutomationRun::STOPPED, 'opted_out');

                        return;
                    }
                    if ($firstMessage && in_array($outcome['reason'], ['not_eligible', 'no_address'], true)) {
                        $this->finish($run->id, AutomationRun::SKIPPED, 'no_eligible_address');

                        return;
                    }
                }

                continue;
            }

            match ($step['kind']) {
                'add_tag' => $this->addTag($run, $subject, $step),
                'notify_team' => $this->notifyTeam($run, $store, $subject, $step),
            };
            $i = $this->advance($run, $i + 1);
        }

        $this->finish($run->id, AutomationRun::COMPLETED, null);
        Automation::query()->whereKey($run->automation_id)->update(['last_run_at' => now()]);
    }

    /** P86-14 / P86-17 checks before a step; returns a `stopped` reason or null. */
    private function exitReason(AutomationRun $run, Automation $automation, Recipe $recipe, bool $checkWindow): ?string
    {
        $status = Automation::query()->whereKey($automation->id)->value('status');
        if ($status !== Automation::ON) {
            return 'automation_off';
        }
        if (! $this->planAllows()) {
            return 'plan';
        }
        if ($recipe->isRecovery()) {
            if ($run->contact_address !== null && self::orderedSince($run->store_id, $run->contact_address, $run->started_at)) {
                return 'converted';
            }
            if ($checkWindow && $run->window_ends_at !== null && $run->window_ends_at->lte(now())) {
                return 'window_ended';
            }
        }

        return null;
    }

    /** An order of the store from this normalized phone placed at or after `$since` (P86-14). */
    public static function orderedSince(string $storeId, string $phone, Carbon $since): bool
    {
        return Order::query()->where('store_id', $storeId)->where('customer_phone', $phone)->where('placed_at', '>=', $since)->exists();
    }

    /**
     * §6 send_message. Checks in order: eligibility → address → suppression → coupon → frequency cap → allowance; then
     * the step row (`sending`, before the provider call) and the send.
     *
     * @param  array<string, mixed>  $step
     * @return array{status: string, reason: string|null}|null null = the step already had a row (never re-executed)
     */
    private function sendMessage(AutomationRun $run, Automation $automation, Recipe $recipe, Store $store, Subject $subject, array $step): ?array
    {
        $message = (array) $step['message'];
        $channel = (string) ($message['channel'] ?? 'sms');
        $contact = $recipe->isRecovery();
        $address = $contact
            ? ($channel === 'sms' ? ($run->contact_address ?? $subject->phone) : $subject->email)
            : $subject->address($channel, false);
        $detail = $contact ? ['message_step' => (int) $step['message_step']] : [];
        $coupon = self::couponFor($store, $message, $step['coupon_id'] ?? null);
        if ($coupon !== null) {
            $detail['coupon_code'] = $coupon->code;
        }

        $reason = match (true) {
            // P85-3 / P86-11: recovery messages go to the checkout contact; everything else needs an eligible customer.
            ! $contact && ($subject->customer === null || ! ($subject->customer->accepts_marketing || $subject->customer->orders_count >= 1)) => 'not_eligible',
            $address === null => 'no_address',
            Suppressions::exists($store->id, $channel, $address) => 'opted_out',
            self::usesCoupon($message) && ($coupon === null || $coupon->displayStatus() !== 'active') => 'coupon_inactive',
            self::recentCount($channel, $address) >= (int) config('automations.frequency_cap', 2) => 'frequency_cap',
            default => null,
        };

        $brand = StoreBrand::of($store);
        $code = UnsubscribeCodes::generate();
        $rendered = null;
        if ($reason === null) {
            $rendered = AutomationMessages::render(
                $message, $brand, $subject->name ?? $subject->customer?->name, $code, $coupon?->code, $subject->product,
                $subject->order?->number, $contact ? AutomationMessages::cartLink($brand, RecoveryCodes::for($run->id)) : null,
            );
            $tenant = $this->context->tenant();
            if ($tenant === null) {
                $reason = 'allowance';
            } else {
                $summary = CampaignAllowance::summary($tenant, $channel, $rendered['parts']);
                if ($summary['limit'] !== null && $summary['limit'] < $summary['used'] + $rendered['parts']) {
                    $reason = 'allowance';
                }
            }
        }

        if ($reason !== null) {
            $row = $this->insertStep($run, (int) $step['index'], AutomationRunStep::SEND_MESSAGE, AutomationRunStep::SKIPPED, $reason, $channel, $address, 0, null, $detail);

            return $row ? ['status' => AutomationRunStep::SKIPPED, 'reason' => $reason] : null;
        }

        // P86-5: the row exists as `sending` before the provider is called; a conflict means it ran already.
        $row = $this->insertStep($run, (int) $step['index'], AutomationRunStep::SEND_MESSAGE, AutomationRunStep::SENDING, null, $channel, $address, $rendered['parts'], UnsubscribeCodes::hash($code), $detail);
        if (! $row) {
            return null;
        }
        $error = null;
        $providerId = null;
        try {
            $providerId = $channel === 'sms'
                ? $this->messenger->sms($store->id, $address, $rendered['text'])
                : $this->messenger->email($brand, $address, (array) $rendered['email']);
        } catch (CampaignSendFailed $e) {
            $error = $e->errorCode;
        }
        AutomationRunStep::query()->where('run_id', $run->id)->where('step_index', (int) $step['index'])->where('status', AutomationRunStep::SENDING)
            ->update($error === null
                ? ['status' => AutomationRunStep::DONE, 'provider_message_id' => $providerId, 'executed_at' => now(), 'updated_at' => now()]
                : ['status' => AutomationRunStep::FAILED, 'reason' => $error, 'parts' => 0, 'updated_at' => now()]);
        if ($channel === 'sms') {
            SmsMessage::query()->create([
                'tenant_id' => $run->tenant_id, 'to' => $address, 'purpose' => 'automation', 'template' => 'automation:'.$automation->id,
                'provider_message_id' => $providerId, 'status' => $error === null ? 'sent' : 'failed', 'error' => $error,
            ]);
        }
        if ($error === null) {
            DevMessageSink::record($store->id, [
                'channel' => $channel, 'to' => $address, 'subject' => $rendered['subject'], 'text' => $rendered['text'],
                'unsubscribe_url' => $rendered['unsubscribe_url'], 'campaign_id' => null, 'is_test' => false, 'automation_id' => $automation->id,
            ]);
        }

        return ['status' => $error === null ? AutomationRunStep::DONE : AutomationRunStep::FAILED, 'reason' => $error];
    }

    /** §6 add_tag (inside one transaction with its step row; CustomerService, no audit row — the run log is the record). @param array<string, mixed> $step */
    private function addTag(AutomationRun $run, Subject $subject, array $step): void
    {
        $tag = mb_strtolower(trim((string) $step['tag']));
        DB::transaction(function () use ($run, $subject, $step, $tag) {
            $customer = $subject->customer !== null ? Customer::query()->whereKey($subject->customer->id)->lockForUpdate()->first() : null;
            $tags = array_map(fn ($t) => mb_strtolower((string) $t), (array) ($customer?->tags ?? []));
            $reason = match (true) {
                $customer === null => 'no_customer',
                in_array($tag, $tags, true) => 'already_tagged',
                count($tags) >= 20 => 'tags_full',
                default => null,
            };
            $inserted = $this->insertStep($run, (int) $step['index'], AutomationRunStep::ADD_TAG,
                $reason === null ? AutomationRunStep::DONE : AutomationRunStep::SKIPPED, $reason, null, null, 0, null, ['tag' => $tag]);
            if ($inserted && $reason === null && $customer !== null) {
                $store = Store::query()->findOrFail($customer->store_id);
                app(CustomerService::class)->update($store, $customer, ['tags' => [...$tags, $tag]], null, null);
            }
        });
    }

    /** §6 notify_team (P86-19): email to the current team with the permission; no customer data. @param array<string, mixed> $step */
    private function notifyTeam(AutomationRun $run, Store $store, Subject $subject, array $step): void
    {
        $recipients = TeamRecipients::for(Permission::InventoryAdjust);
        if ($recipients === []) {
            $this->insertStep($run, (int) $step['index'], AutomationRunStep::NOTIFY_TEAM, AutomationRunStep::SKIPPED, 'no_recipients', null, null, 0, null, ['recipients' => 0]);

            return;
        }
        $inserted = $this->insertStep($run, (int) $step['index'], AutomationRunStep::NOTIFY_TEAM, AutomationRunStep::DONE, null, null, null, 0, null, ['recipients' => count($recipients)]);
        if (! $inserted) {
            return;
        }
        $context = $subject->context;
        $url = rtrim((string) config('storeplix.merchant_app_url'), '/').'/products/'.($context['product_id'] ?? '');
        try {
            foreach ($recipients as $email) {
                Mail::to($email)->queue((new LowStockMail(
                    (string) $store->name,
                    (string) ($context['product_name'] ?? 'Product'),
                    $context['variant_name'] ?? null,
                    (int) ($subject->inventory?->on_hand ?? $context['on_hand'] ?? 0),
                    $url,
                ))->onQueue((string) config('automations.notifications_queue', 'notifications')));
            }
        } catch (Throwable $e) {
            report($e);
            AutomationRunStep::query()->where('run_id', $run->id)->where('step_index', (int) $step['index'])
                ->update(['status' => AutomationRunStep::FAILED, 'reason' => 'provider_error', 'updated_at' => now()]);
        }
    }

    /** @param array<string, mixed>|null $detail @return bool true when this call created the row */
    private function insertStep(AutomationRun $run, int $index, string $action, string $status, ?string $reason, ?string $channel, ?string $address, int $parts, ?string $codeHash, ?array $detail): bool
    {
        $now = now();

        return AutomationRunStep::query()->insertOrIgnore([[
            'id' => strtolower((string) Str::ulid()),
            'tenant_id' => $run->tenant_id,
            'store_id' => $run->store_id,
            'run_id' => $run->id,
            'step_index' => $index,
            'action' => $action,
            'status' => $status,
            'reason' => $reason,
            'channel' => $channel,
            'address' => $address,
            'parts' => $parts,
            'unsubscribe_code_hash' => $codeHash,
            'provider_message_id' => null,
            'detail' => $detail === null || $detail === [] ? null : json_encode($detail),
            'executed_at' => $now,
            'created_at' => $now,
            'updated_at' => $now,
        ]]) === 1;
    }

    /** @param array<string, mixed> $context */
    private function insertRun(Automation $automation, string $trigger, string $dedupe, string $subjectType, string $subjectId, ?string $customerId, ?string $contact, array $context, Carbon $now, ?Carbon $window): ?string
    {
        $id = strtolower((string) Str::ulid());
        $recovery = $automation->recipeDefinition()->isRecovery();
        $inserted = AutomationRun::query()->insertOrIgnore([[
            'id' => $id,
            'tenant_id' => $automation->tenant_id,
            'store_id' => $automation->store_id,
            'automation_id' => $automation->id,
            'trigger' => $trigger,
            'dedupe_key' => mb_substr($dedupe, 0, 120),
            'subject_type' => $subjectType,
            'subject_id' => strtolower($subjectId),
            'customer_id' => $customerId,
            'contact_address' => $contact,
            'status' => AutomationRun::RUNNING,
            'next_step' => 0,
            'recovery_code_hash' => $recovery ? RecoveryCodes::hash(RecoveryCodes::for($id)) : null,
            'window_ends_at' => $window,
            'context' => json_encode((object) $context),
            'started_at' => $now,
            'created_at' => $now,
            'updated_at' => $now,
        ]]);

        return $inserted === 1 ? $id : null;
    }

    private function wait(AutomationRun $run, int $nextStep, Carbon $until): void
    {
        AutomationRun::query()->whereKey($run->id)->where('status', AutomationRun::RUNNING)
            ->update(['status' => AutomationRun::WAITING, 'next_step' => $nextStep, 'resume_at' => $until, 'updated_at' => now()]);
    }

    private function advance(AutomationRun $run, int $nextStep): int
    {
        AutomationRun::query()->whereKey($run->id)->update(['next_step' => $nextStep, 'updated_at' => now()]);

        return $nextStep;
    }

    /** Terminal status by conditional UPDATE (only open runs move). @param array<string, mixed>|null $detail */
    public function finish(string $runId, string $status, ?string $reason, ?array $detail = null): bool
    {
        $values = ['status' => $status, 'outcome_reason' => $reason, 'resume_at' => null, 'finished_at' => now(), 'updated_at' => now()];
        if ($detail !== null) {
            $values['outcome_detail'] = json_encode($detail);
        }

        return AutomationRun::query()->whereKey($runId)->whereIn('status', AutomationRun::OPEN)->update($values) === 1;
    }

    private function planAllows(): bool
    {
        $tenant = $this->context->tenant();

        return $tenant !== null && FeatureGate::allows($tenant, Feature::SmsAutomation);
    }

    /** The customer's address for the recipe's (first) message channel, else the phone (run log + matching). @param array<string, mixed> $settings */
    private function customerAddress(Subject $subject, Recipe $recipe, array $settings): ?string
    {
        foreach ($recipe->flow($settings) as $step) {
            if ($step['kind'] === 'send_message' && ($address = $subject->address((string) ($step['message']['channel'] ?? 'sms'), false)) !== null) {
                return $address;
            }
        }

        return $subject->address('sms', false) ?? $subject->address('email', false);
    }

    /** P86-10: automation messages to this address in the last 24 h (all automations of the store). */
    public static function recentCount(string $channel, string $address): int
    {
        return AutomationRunStep::query()->where('action', AutomationRunStep::SEND_MESSAGE)->where('channel', $channel)->where('address', $address)
            ->whereIn('status', AutomationRunStep::COUNTED)
            ->where('executed_at', '>=', now()->subHours((int) config('automations.frequency_window_hours', 24)))->count();
    }

    /** @param array<string, mixed> $message */
    public static function usesCoupon(array $message): bool
    {
        return str_contains((string) ($message['body'] ?? ''), '{coupon}') || str_contains((string) ($message['subject'] ?? ''), '{coupon}');
    }

    /** @param array<string, mixed> $message */
    public static function couponFor(Store $store, array $message, ?string $couponId): ?Coupon
    {
        if ($couponId === null || ! self::usesCoupon($message)) {
            return null;
        }

        return Coupon::query()->where('store_id', $store->id)->whereKey($couponId)->first();
    }

    /** @param list<array{field: string, label: string, passed: bool, detail: string|null}> $results @return list<array<string, mixed>> */
    public static function conditionDetail(array $results): array
    {
        return array_map(fn ($r) => ['field' => $r['field'], 'label' => $r['label'], 'passed' => $r['passed'], 'detail' => $r['detail']], $results);
    }
}
