<!doctype html>
<html><body style="font-family: Inter, Arial, sans-serif; color:#0d0d18">
<h2>Thank you for your order, {{ explode(' ', $order->customer_name)[0] }}!</h2>
<p>{{ $shop }} received your order <strong>{{ $order->number }}</strong>. Pay <strong>{{ $money($order->total_amount) }}</strong> in cash when it arrives.</p>
<table cellpadding="6" style="border-collapse:collapse">
@foreach ($order->items as $item)
<tr><td>{{ $item->product_name }}@if($item->variant_title !== '' && $item->variant_title !== 'Default') · {{ $item->variant_title }}@endif × {{ $item->quantity }}</td><td align="right">{{ $money($item->total_amount) }}</td></tr>
@endforeach
<tr><td>Subtotal</td><td align="right">{{ $money($order->subtotal_amount) }}</td></tr>
@if ($order->discount_amount > 0)<tr><td>Discount @if($order->coupon_code)({{ $order->coupon_code }})@endif</td><td align="right">−{{ $money($order->discount_amount) }}</td></tr>@endif
<tr><td>Delivery · {{ $order->shipping_zone_name }}</td><td align="right">{{ $order->shipping_amount === 0 ? 'Free' : $money($order->shipping_amount) }}</td></tr>
<tr><td><strong>Total</strong></td><td align="right"><strong>{{ $money($order->total_amount) }}</strong></td></tr>
</table>
<p>Delivering to: {{ $order->shipping_address['address_line'] ?? '' }}, {{ $order->shipping_address['thana'] ?? '' }}, {{ $order->shipping_address['district'] ?? '' }}</p>
@if ($trackUrl)<p><a href="{{ $trackUrl }}" style="background:#5b53ff;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Track your order</a></p>@endif
</body></html>
