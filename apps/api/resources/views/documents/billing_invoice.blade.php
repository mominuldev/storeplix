{{-- PHASE-7 P7-15 / S64: Storeplix invoice to a merchant. Only {{ }} output (every merchant value escaped); no remote URL. --}}
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
body { font-family: 'Inter', sans-serif; font-size: 10pt; color: #111; margin: 0; position: relative; }
h1 { font-size: 18pt; margin: 0 0 4pt; }
.muted { color: #555; }
.row { display: flex; justify-content: space-between; gap: 12pt; margin-bottom: 14pt; }
table { width: 100%; border-collapse: collapse; margin-top: 8pt; }
th, td { padding: 5pt 4pt; text-align: left; vertical-align: top; }
th { border-bottom: 1px solid #111; font-size: 9pt; }
td { border-bottom: 1px solid #ddd; }
.right { text-align: right; }
.total td { font-weight: 700; border-bottom: none; }
.void { position: fixed; top: 40%; left: 0; right: 0; text-align: center; font-size: 96pt; color: rgba(200, 0, 0, .18); transform: rotate(-24deg); font-weight: 700; }
.status { display: inline-block; padding: 2pt 8pt; border-radius: 8pt; border: 1px solid #111; font-size: 9pt; text-transform: uppercase; }
</style>
</head>
<body>
@if ($status === 'void')<div class="void">VOID</div>@endif
<div class="row">
  <div>
    <h1>Invoice {{ $number }}</h1>
    <div class="muted">Issued {{ $issued }} · Due {{ $due }}</div>
    <div><span class="status">{{ $status }}</span>@if ($paid) · Paid {{ $paid }}@endif</div>
  </div>
  <div class="right">
    <strong>{{ $seller }}</strong>
    @if ($bin)<div class="muted">VAT BIN {{ $bin }}</div>@endif
  </div>
</div>
<div class="row">
  <div>
    <div class="muted">Bill to</div>
    <strong>{{ $billTo['name'] ?? '' }}</strong>
    @if (! empty($billTo['address']))<div>{{ $billTo['address'] }}</div>@endif
    @if (! empty($billTo['email']))<div>{{ $billTo['email'] }}</div>@endif
    @if (! empty($billTo['phone']))<div>{{ $billTo['phone'] }}</div>@endif
  </div>
  @if ($period)
  <div class="right"><div class="muted">Service period</div>{{ $period }}</div>
  @endif
</div>
<table>
  <thead><tr><th>Description</th><th class="right">Qty</th><th class="right">Amount</th></tr></thead>
  <tbody>
  @foreach ($lines as $line)
    <tr><td>{{ $line['description'] }}</td><td class="right">{{ $line['quantity'] }}</td><td class="right">{{ $line['amount'] }}</td></tr>
  @endforeach
  </tbody>
</table>
<table>
  <tr><td>Subtotal (excl. VAT)</td><td class="right">{{ $subtotal }}</td></tr>
  <tr><td>VAT {{ $rate }} (included)</td><td class="right">{{ $tax }}</td></tr>
  <tr class="total"><td>Total</td><td class="right">{{ $total }}</td></tr>
</table>
<p class="muted">Prices include VAT. Paid by {{ $paidWith ?? '—' }}.</p>
</body>
</html>
