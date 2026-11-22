@extends('documents.layout')
@section('body')
@foreach ($docs as $d)
<section class="page">
  <div class="row">
    <div>
      @if ($shop['logo'])<img class="logo" src="{{ $shop['logo'] }}" alt="">@endif
      <div class="bold">{{ $shop['name'] }}</div>
    </div>
    <div class="right">
      <h1>{{ $t('packing_slip') }}</h1>
      <div class="small">{{ $t('order_no') }} <span class="bold">{{ $d['number'] }}</span> · {{ $d['date'] }}</div>
    </div>
  </div>
  <div style="margin: 8pt 0;">
    <div class="small muted">{{ $t('ship_to') }}</div>
    <div class="bold">{{ $d['name'] }}</div>
    <div class="small">{{ $d['phone'] }} · {{ $d['address'] }}</div>
  </div>
  <table>
    <thead><tr><th>{{ $t('item') }}</th>@if ($config['show_sku'])<th>{{ $t('sku') }}</th>@endif<th class="right">{{ $t('qty') }}</th><th class="right">{{ $t('packed') }}</th></tr></thead>
    <tbody>
    @foreach ($d['lines'] as $line)
      <tr>
        <td>{{ $line['name'] }} @if ($line['variant'] !== '' && $line['variant'] !== 'Default')<span class="muted small">{{ $line['variant'] }}</span>@endif</td>
        @if ($config['show_sku'])<td class="small">{{ $line['sku'] }}</td>@endif
        <td class="right bold">{{ $line['qty'] }}</td>
        <td class="right"><span class="checkbox"></span></td>
      </tr>
    @endforeach
    </tbody>
  </table>
  @if ($d['note'])<div class="footer">{{ $d['note'] }}</div>@endif
  @if ($footer)<div class="footer">{{ $footer }}</div>@endif
</section>
@endforeach
@endsection
