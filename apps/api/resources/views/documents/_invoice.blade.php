{{-- One invoice (A4 page, A5 half or 80 mm roll); $d = order view data, $compact = narrow layout. --}}
<div class="row">
  <div>
    @if ($shop['logo'])<img class="logo" src="{{ $shop['logo'] }}" alt="">@endif
    <div class="bold">{{ $shop['name'] }}</div>
    @if ($shop['address'])<div class="small muted">{{ $shop['address'] }}</div>@endif
    @if ($shop['phone'])<div class="small muted">{{ $t('phone') }}: {{ $shop['phone'] }}</div>@endif
    @if ($shop['bin'])<div class="small muted">{{ $t('bin') }}: {{ $shop['bin'] }}</div>@endif
  </div>
  <div class="right">
    <h1>{{ $compact ? $t('receipt') : $t('invoice') }}</h1>
    <div class="small">{{ $t('invoice_no') }} <span class="bold">{{ $d['number'] }}</span></div>
    <div class="small">{{ $t('date') }}: {{ $d['date'] }}</div>
  </div>
</div>
<div class="{{ $compact ? '' : 'row' }}" style="margin: 8pt 0;">
  <div>
    <div class="small muted">{{ $t('ship_to') }}</div>
    <div class="bold">{{ $d['name'] }}</div>
    <div class="small">{{ $d['phone'] }}</div>
    <div class="small">{{ $d['address'] }}</div>
  </div>
</div>
<table>
  <thead><tr>
    <th>{{ $t('item') }}</th><th class="right">{{ $t('qty') }}</th>
    @if ($config['show_prices'])<th class="right">{{ $t('unit_price') }}</th><th class="right">{{ $t('amount') }}</th>@endif
  </tr></thead>
  <tbody>
  @foreach ($d['lines'] as $line)
    <tr>
      <td>@if ($config['show_product_names']){{ $line['name'] }}@endif @if ($line['variant'] !== '' && $line['variant'] !== 'Default')<span class="muted small">{{ $line['variant'] }}</span>@endif
        @if ($line['sku'])<div class="small muted">{{ $t('sku') }}: {{ $line['sku'] }}</div>@endif</td>
      <td class="right">{{ $line['qty'] }}</td>
      @if ($config['show_prices'])<td class="right">{{ $line['unit'] }}</td><td class="right">{{ $line['total'] }}</td>@endif
    </tr>
  @endforeach
  </tbody>
</table>
@if ($config['show_prices'])
<table class="totals" style="margin-top: 6pt;">
  <tr><td>{{ $t('subtotal') }}</td><td class="right">{{ $d['subtotal'] }}</td></tr>
  @if ($d['discount'])<tr><td>{{ $t('discount') }}@if ($d['coupon']) ({{ $d['coupon'] }})@endif</td><td class="right">{{ $d['discount'] }}</td></tr>@endif
  <tr><td>{{ $t('delivery') }}</td><td class="right">{{ $d['delivery'] }}</td></tr>
  <tr class="grand"><td>{{ $t('total') }}</td><td class="right">{{ $d['total'] }}</td></tr>
  @if ($d['vat'])<tr><td colspan="2" class="small muted">{{ $d['vat'] }}</td></tr>@endif
  @if ($d['paid'])<tr><td>{{ $t('paid') }}</td><td class="right">{{ $d['paid'] }}</td></tr>@endif
  <tr class="bold"><td>{{ $t('due') }}</td><td class="right">{{ $d['due'] }}</td></tr>
  <tr><td class="small">{{ $t('payment_method') }}</td><td class="right small">{{ $t($d['method']) }}</td></tr>
</table>
@endif
<div class="footer">{{ $footer ?? $t('thank_you') }}</div>
