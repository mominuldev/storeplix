<!doctype html>
<html><body style="font-family: Inter, Arial, sans-serif; color:#0d0d18">
@if ($reason === 'token_expired')
<h2>Reconnect {{ $label }}</h2>
<p>The access {{ $shop }} gave Store Plix for {{ $label }} has expired, so @if ($feed)your products are no longer synced@else purchases are no longer sent from the server@endif. Open the integration and reconnect it.</p>
@else
<h2>Your {{ $label }} access token stopped working</h2>
<p>{{ $label }} refused the access token saved for {{ $shop }}. We stopped @if ($feed)syncing products@else sending events@endif so nothing is retried against a dead token. Paste a new token (or reconnect) and we'll pick up again.</p>
@endif
<p><a href="{{ $url }}" style="background:#5b53ff;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open {{ $label }}</a></p>
</body></html>
