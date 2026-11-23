<!doctype html>
<html><body style="font-family: Inter, Arial, sans-serif; color:#0d0d18">
@if ($kind === 'suspended')
<h2>{{ $shop }} is suspended</h2>
<p>Your shop's dashboard and storefront are offline for now. Your data is kept. Contact Store Plix support to find out more.</p>
@elseif ($kind === 'reactivated')
<h2>{{ $shop }} is active again</h2>
<p>Your dashboard and storefront are back online.</p>
@else
<h2>Your plan changed to {{ $data['plan'] ?? '' }}</h2>
<p>Store Plix support changed the plan of {{ $shop }}. There is nothing to pay for this change.</p>
@endif
@if ($kind !== 'suspended')
<p><a href="{{ $url }}" style="background:#5b53ff;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open your dashboard</a></p>
@endif
</body></html>
