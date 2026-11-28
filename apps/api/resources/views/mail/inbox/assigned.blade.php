<!doctype html>
<html><body style="font-family: Inter, Arial, sans-serif; color:#0d0d18">
<h2>{{ $actor }} assigned you a conversation with {{ $contact }}</h2>
@if ($preview !== '')
<p style="color:#3d3d52">“{{ $preview }}”</p>
@endif
<p>{{ $shop }} · Inbox</p>
<p><a href="{{ $url }}" style="background:#5b53ff;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open the conversation</a></p>
</body></html>
