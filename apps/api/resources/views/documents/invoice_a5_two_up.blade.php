@extends('documents.layout')
@section('body')
{{-- Two halves + 5 mm gap must fit A4's 277 mm printable height (297 − 2 × 10 mm margins): 135 + 5 + 135 = 275 mm. --}}
<style>.half { height: 135mm; overflow: hidden; font-size: 8.5pt; } .half + .half { border-top: 1px dashed #999; padding-top: 5mm; margin-top: 5mm; } h1 { font-size: 13pt; }</style>
@foreach (array_chunk($docs, 2) as $pair)
<section class="page">
  @foreach ($pair as $d)
  <div class="half">@include('documents._invoice', ['d' => $d, 'compact' => false])</div>
  @endforeach
</section>
@endforeach
@endsection
