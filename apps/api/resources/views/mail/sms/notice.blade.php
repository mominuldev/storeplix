<!doctype html>
<html><body style="font-family: Inter, Arial, sans-serif; color:#0d0d18">
@if ($kind === 'low_credits')
<h2>{{ $data['balance'] }} SMS credits left</h2>
<p>{{ $shop }} is running low on SMS credits. When the monthly allowance and the credits are both used up, order SMS stop. Buy more before messages stop.</p>
@elseif ($kind === 'sender_id_requested')
<h2>We got your sender ID request: {{ $data['sender_id'] }}</h2>
<p>Store Plix checks your trade licence, then registers {{ $data['sender_id'] }} with BTRC through REVE SMS. This usually takes 7–10 working days. Until then your SMS keep going out from Storeplix.</p>
@elseif ($kind === 'sender_id_requested_ops')
<h2>New sender ID request: {{ $data['sender_id'] }}</h2>
<p>{{ $shop }} asked for the masked sender ID {{ $data['sender_id'] }}. Review it in the super admin under Sender ID requests.</p>
@elseif ($kind === 'sender_id_approved')
<h2>Your sender ID {{ $data['sender_id'] }} is live</h2>
<p>From now on, {{ $shop }}'s SMS come from {{ $data['sender_id'] }} and the shop-name prefix is removed.</p>
@elseif ($kind === 'sender_id_rejected')
<h2>Your sender ID request {{ $data['sender_id'] }} was not approved</h2>
<p>Reason: {{ $data['reason'] }}</p>
<p>Your SMS keep going out from Storeplix. You can send a new request.</p>
@else
<h2>Your sender ID {{ $data['sender_id'] }} was turned off</h2>
<p>Reason: {{ $data['reason'] }}</p>
<p>{{ $shop }}'s SMS go out from Storeplix with the shop-name prefix again.</p>
@endif
@if ($kind !== 'sender_id_requested_ops')
<p><a href="{{ $url }}" style="background:#5b53ff;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open SMS settings</a></p>
@endif
</body></html>
