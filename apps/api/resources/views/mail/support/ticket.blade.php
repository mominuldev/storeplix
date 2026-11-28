<!doctype html>
<html><body style="font-family: Inter, Arial, sans-serif; color:#0d0d18">
<h2>{{ $headline }}</h2>
<p style="color:#3d3d52"><strong>{{ $reference }}</strong> · {{ $ticketSubject }}</p>
@if ($preview !== '')
<p style="color:#3d3d52;white-space:pre-line">“{{ $preview }}”</p>
@endif
<p>{{ $shop }}</p>
<p><a href="{{ $url }}" style="background:#5b53ff;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">{{ $cta }}</a></p>
<p style="color:#6b6b80;font-size:12px">Please reply in Store Plix, not by email.</p>
</body></html>
