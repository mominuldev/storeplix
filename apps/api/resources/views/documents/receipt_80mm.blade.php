@extends('documents.layout')
@section('body')
<style>body { font-size: 8.5pt; width: 72mm; } h1 { font-size: 12pt; } .receipt { padding-bottom: 6mm; border-bottom: 1px dashed #111; margin-bottom: 6mm; }</style>
@foreach ($docs as $d)
<section class="receipt">@include('documents._invoice', ['d' => $d, 'compact' => true])</section>
@endforeach
@endsection
