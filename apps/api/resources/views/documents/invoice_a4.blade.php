@extends('documents.layout')
@section('body')
@foreach ($docs as $d)
<section class="page">@include('documents._invoice', ['d' => $d, 'compact' => false])</section>
@endforeach
@endsection
