<!doctype html>
<html><body style="font-family: Inter, Arial, sans-serif; color:#0d0d18">
@if ($kind === 'trial_ending')
<h2>Your Starter trial ends on {{ $data['date'] }}</h2>
<p>After that, {{ $shop }} moves to the Free plan. Nothing is deleted. Choose a plan to keep Starter features.</p>
@elseif ($kind === 'invoice_issued')
<h2>Invoice {{ $data['number'] }} · {{ $data['amount'] }}</h2>
<p>Your {{ $data['plan'] }} plan for {{ $shop }} renews on {{ $data['date'] }}. Pay with bKash or card from Plan &amp; billing.</p>
@elseif ($kind === 'reminder')
<h2>Your {{ $data['plan'] }} plan renews on {{ $data['date'] }}</h2>
<p>Invoice {{ $data['number'] }} ({{ $data['amount'] }}) for {{ $shop }} is still open.</p>
@elseif ($kind === 'payment_received')
<h2>Thank you: {{ $data['amount'] }} received</h2>
<p>Invoice {{ $data['number'] }} for {{ $shop }} is paid. Your {{ $data['plan'] }} plan runs until {{ $data['date'] }}. You can download the receipt from Plan &amp; billing.</p>
@elseif ($kind === 'past_due')
<h2>Payment failed for your {{ $data['plan'] }} plan</h2>
<p>Invoice {{ $data['number'] }} for {{ $shop }} wasn't paid. Pay by {{ $data['date'] }} to keep your plan. After that, the shop moves to the Free plan.</p>
@elseif ($kind === 'grace_ending')
<h2>Pay by {{ $data['date'] }} to keep your {{ $data['plan'] }} plan</h2>
<p>Invoice {{ $data['number'] }} for {{ $shop }} is overdue. Your shop moves to the Free plan on {{ $data['date'] }} if it stays unpaid.</p>
@elseif ($kind === 'dropped_to_free')
<h2>{{ $shop }} is now on the Free plan</h2>
<p>Nothing was deleted. Things above the Free limits keep working, but you can't add more until you upgrade.</p>
@elseif ($kind === 'domain_will_detach')
<h2>Your custom domain stops working on {{ $data['date'] }}</h2>
<p>{{ $shop }}'s plan no longer includes all of its custom domains. Upgrade before {{ $data['date'] }} to keep them connected.</p>
@elseif ($kind === 'sms_credits_added')
<h2>{{ $data['credits'] }} SMS credits added</h2>
<p>Invoice {{ $data['number'] }} ({{ $data['amount'] }}) for {{ $shop }} is paid. Your shop now has {{ $data['balance'] }} SMS credits. They are used after the monthly allowance and never expire.</p>
@else
<h2>Billing alert: {{ $data['event'] }}</h2>
<p>Tenant {{ $data['tenant'] }} ({{ $shop }}), invoice {{ $data['number'] ?? '—' }}, payment {{ $data['payment'] ?? '—' }}, {{ $data['detail'] ?? '' }}. Check the provider panel and refund if needed (Q89).</p>
@endif
@if ($kind !== 'ops_alert')
<p><a href="{{ $url }}" style="background:#5b53ff;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">{{ $kind === 'sms_credits_added' ? 'Open SMS credits' : 'Open Plan & billing' }}</a></p>
@endif
</body></html>
