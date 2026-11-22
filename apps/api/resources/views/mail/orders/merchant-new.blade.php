<!doctype html>
<html><body style="font-family: Inter, Arial, sans-serif; color:#0d0d18">
<h2>New order {{ $order->number }} · {{ $money($order->total_amount) }}</h2>
<p>{{ $shop }} has a new {{ $order->created_via === 'storefront' ? 'website' : $order->channel }} order with {{ $order->items->sum('quantity') }} item(s), cash on delivery.</p>
<p><a href="{{ $url }}" style="background:#5b53ff;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open the order</a></p>
<p>Call the customer to confirm it, then mark it packed and shipped.</p>
</body></html>
