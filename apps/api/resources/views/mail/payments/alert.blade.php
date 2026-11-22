<!doctype html>
<html><body style="font-family: Inter, Arial, sans-serif; color:#0d0d18">
@if ($kind === 'mismatch')
<h2>A payment for order {{ $order->number }} wasn’t accepted</h2>
<p>{{ $gateway }} reported a payment of {{ $amount }} for {{ $shop }} that didn’t match the order ({{ $failureCode }}). The order wasn’t marked paid. Check the payment in your {{ $gateway }} panel before you ship.</p>
@elseif ($kind === 'late_refund')
<h2>Paid after the order expired — refunded</h2>
<p>The customer paid {{ $amount }} with {{ $gateway }} for order {{ $order->number }} after its payment window closed, so the order stayed cancelled.
@if ($refundStatus === 'succeeded') The full amount was refunded. @elseif ($refundStatus === 'pending') The refund is being processed. @else The automatic refund didn’t go through: refund it from the order page or your {{ $gateway }} panel. @endif
</p>
@else
<h2>A refund for order {{ $order->number }} failed</h2>
<p>{{ $gateway }} didn’t complete the refund of {{ $amount }}. Try again from the order page, or refund the customer another way and record it as a manual refund.</p>
@endif
<p><a href="{{ $url }}" style="background:#5b53ff;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open the order</a></p>
</body></html>
