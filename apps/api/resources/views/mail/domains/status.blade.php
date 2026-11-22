<!doctype html>
<html><body style="font-family: Inter, Arial, sans-serif; color:#0d0d18">
@if ($kind === 'live')
<h2>{{ $hostname }} is live</h2>
<p>Your domain is connected and secured. Shoppers can now visit {{ $shop }} at <strong>{{ $hostname }}</strong>. Make it your primary address to send every visitor there.</p>
@elseif ($kind === 'dns_missing')
<h2>The DNS records for {{ $hostname }} are missing</h2>
<p>We couldn't find the DNS records that connect {{ $hostname }} to {{ $shop }}@if ($detail) ({{ $detail }})@endif. Your domain keeps working for now. Put the records back within {{ $days }} days, or the domain will be disconnected.</p>
@elseif ($kind === 'failed')
<h2>We couldn't connect {{ $hostname }}</h2>
<p>@if ($detail){{ $detail }} @endif Check the DNS records on the Domains page and press "Check now" to try again.</p>
@elseif ($kind === 'expired')
<h2>{{ $hostname }} was disconnected</h2>
<p>The DNS records for {{ $hostname }} were missing for {{ $days }} days, so we disconnected it from {{ $shop }}. Add the records again and press "Check now" to reconnect it.</p>
@elseif ($kind === 'primary_fallback')
<h2>Your shop is back on {{ $fallbackHost }}</h2>
<p>{{ $hostname }} can't serve {{ $shop }} right now, so visitors now go to {{ $fallbackHost }}. When {{ $hostname }} is connected again, make it primary again on the Domains page.</p>
@else
<h2>{{ $hostname }} was released</h2>
<p>{{ $hostname }} was never verified for {{ $shop }} (or stayed disconnected), and another shop has proved it owns it. We removed it from your Domains page.</p>
@endif
<p><a href="{{ $url }}" style="background:#5b53ff;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open Domains</a></p>
</body></html>
