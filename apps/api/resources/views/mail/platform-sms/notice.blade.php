<!doctype html>
<html><body style="font-family: Inter, Arial, sans-serif; color:#0d0d18">
@if ($kind === 'low_balance')
<h2>{{ $data['provider'] }} balance is low: {{ $data['balance'] }}</h2>
<p>The SMS gateway balance is below {{ $data['threshold'] }}. When it runs out, sign-in codes, invoices and shop SMS stop. Balance is bought from the provider.</p>
@else
<h2>SMS failover started</h2>
<p>{{ $data['provider'] }} failed ({{ $data['error_code'] }}). Messages now go through {{ $data['failover'] ?? 'no failover provider' }}. Store Plix tries {{ $data['provider'] }} again after 5 minutes without errors.</p>
@endif
<p><a href="{{ $url }}" style="background:#5b53ff;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open SMS provider</a></p>
</body></html>
