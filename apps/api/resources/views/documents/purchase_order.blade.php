{{-- PHASE-8-8B §5.6 / P88B-14: a purchase order to a supplier. Only {{ }} output (every merchant value escaped); no remote URL. --}}
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{{ $number }}</title>
<style>
@if ($fonts)
@font-face { font-family: 'Inter'; src: url('Inter-Regular.woff2') format('woff2'); font-weight: 400; }
@font-face { font-family: 'Inter'; src: url('Inter-Bold.woff2') format('woff2'); font-weight: 700; }
@endif
@page { size: 210mm 297mm; margin: 14mm; }
* { box-sizing: border-box; }
body { font-family: 'Inter', sans-serif; font-size: 10pt; color: #111; margin: 0; }
h1 { font-size: 18pt; margin: 0 0 4pt; }
.muted { color: #555; }
.row { display: flex; justify-content: space-between; gap: 12pt; margin-bottom: 14pt; }
table { width: 100%; border-collapse: collapse; margin-top: 8pt; }
th, td { padding: 5pt 4pt; text-align: left; vertical-align: top; }
th { border-bottom: 1px solid #111; font-size: 9pt; }
td { border-bottom: 1px solid #ddd; }
.right { text-align: right; }
.total td { font-weight: 700; border-bottom: none; }
.status { display: inline-block; padding: 2pt 8pt; border-radius: 8pt; border: 1px solid #111; font-size: 9pt; text-transform: uppercase; }
</style>
</head>
<body>
<div class="row">
  <div>
    <h1>Purchase order {{ $number }}</h1>
    <div class="muted">Date {{ $created }}@if ($expected) · Expected by {{ $expected }}@endif</div>
    @if (! empty($receiveAt))<div class="muted">Receive at {{ $receiveAt }}</div>@endif
    <div><span class="status">{{ $status }}</span></div>
  </div>
  <div class="right">
    <strong>{{ $store['name'] }}</strong>
    @if ($store['address'])<div class="muted">{{ $store['address'] }}</div>@endif
    @if ($store['phone'])<div class="muted">{{ $store['phone'] }}</div>@endif
  </div>
</div>
<div class="row">
  <div>
    <div class="muted">Supplier</div>
    <strong>{{ $supplier['name'] }}</strong>
    @if ($supplier['contact'])<div>{{ $supplier['contact'] }}</div>@endif
    @if ($supplier['phone'])<div>{{ $supplier['phone'] }}</div>@endif
    @if ($supplier['city'])<div>{{ $supplier['city'] }}</div>@endif
  </div>
</div>
<table>
  <thead><tr><th>Product</th><th>Variant</th><th class="right">Qty</th><th class="right">Unit cost</th><th class="right">Line total</th></tr></thead>
  <tbody>
  @foreach ($lines as $line)
    <tr><td>{{ $line['product'] }}@if ($line['sku'])<div class="muted">{{ $line['sku'] }}</div>@endif</td><td>{{ $line['variant'] }}</td><td class="right">{{ $line['quantity'] }}</td><td class="right">{{ $line['unit'] }}</td><td class="right">{{ $line['total'] }}</td></tr>
  @endforeach
  </tbody>
</table>
<table>
  <tr><td>Items</td><td class="right">{{ $subtotal }}</td></tr>
  @if ($shipping)<tr><td>Transport</td><td class="right">{{ $shipping }}</td></tr>@endif
  @if ($discount)<tr><td>Supplier discount</td><td class="right">− {{ $discount }}</td></tr>@endif
  <tr class="total"><td>Total</td><td class="right">{{ $total }}</td></tr>
</table>
@if ($notes)<p><span class="muted">Notes:</span> {{ $notes }}</p>@endif
</body>
</html>
