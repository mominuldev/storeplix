@extends('documents.layout')
@section('body')
<style>
.label { width: 100mm; height: 150mm; padding: 4mm; overflow: hidden; display: flex; flex-direction: column; gap: 2.5mm; font-size: 9pt; }
.label .head { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #111; padding-bottom: 2mm; }
.label .cash { border: 2px solid #111; text-align: center; padding: 2mm; font-size: 15pt; font-weight: 700; }
.label .barcode { text-align: center; } .label .barcode img { height: 16mm; max-width: 88mm; }
.label .to { border: 1px solid #111; padding: 2mm; } .label .to .name { font-size: 12pt; font-weight: 700; }
.label .foot { display: flex; justify-content: space-between; align-items: flex-end; margin-top: auto; font-size: 7.5pt; }
.label .qr img { width: 20mm; height: 20mm; }
</style>
@foreach ($docs as $d)
<section class="page label">
  <div class="head">
    <div>
      @if ($shop['logo'])<img class="logo" style="max-height: 9mm;" src="{{ $shop['logo'] }}" alt="">@endif
      <div class="bold">{{ $shop['name'] }}</div>
    </div>
    <div class="right">
      @if ($d['courier'])<div class="bold">{{ $d['courier'] }}</div>@endif
      <div class="small">{{ $d['number'] }} · {{ $d['date'] }}</div>
    </div>
  </div>
  <div class="cash">@if ($d['due_amount'] > 0){{ $t('collect_cash') }} {{ $d['due'] }}@else{{ $t('paid_stamp') }}@endif</div>
  @if ($d['barcode'])<div class="barcode"><img src="{{ $d['barcode'] }}" alt=""><div class="small">{{ $d['barcode_text'] }}</div></div>@endif
  <div class="to">
    <div class="small muted">{{ $t('deliver_to') }}</div>
    <div class="name">{{ $d['name'] }}</div>
    <div class="bold">{{ $d['phone'] }}</div>
    <div>{{ $d['address'] }}</div>
    <div class="bold">{{ $d['thana'] }}, {{ $d['district'] }}</div>
  </div>
  @if ($config['show_product_names'])<div class="small"><span class="muted">{{ $t('items') }}:</span> {{ $d['items_summary'] }}</div>@endif
  @if ($d['weight'])<div class="small"><span class="muted">{{ $t('weight') }}:</span> {{ $d['weight'] }}</div>@endif
  <div class="foot">
    <div>
      <div class="muted">{{ $t('return_to') }}</div>
      <div>{{ $shop['name'] }}@if ($shop['phone']) · {{ $shop['phone'] }}@endif</div>
      @if ($shop['address'])<div>{{ $shop['address'] }}</div>@endif
    </div>
    @if ($d['qr'])<div class="qr right"><img src="{{ $d['qr'] }}" alt=""><div>{{ $t('scan_to_track') }}</div></div>@endif
  </div>
</section>
@endforeach
@endsection
