{{-- PHASE-5B §7: shared document shell. Only {{ }} output; images are data URIs; fonts are files sent with the request. --}}
<!DOCTYPE html>
<html lang="{{ $language }}">
<head>
<meta charset="utf-8">
<title>{{ $kind }}</title>
<style>
@if ($fonts)
@font-face { font-family: 'Inter'; src: url('Inter-Regular.woff2') format('woff2'); font-weight: 400; }
@font-face { font-family: 'Inter'; src: url('Inter-Bold.woff2') format('woff2'); font-weight: 700; }
@font-face { font-family: 'Noto Sans Bengali'; src: url('NotoSansBengali-Regular.ttf') format('truetype'); font-weight: 400; }
@font-face { font-family: 'Noto Sans Bengali'; src: url('NotoSansBengali-Bold.ttf') format('truetype'); font-weight: 700; }
@endif
@page { size: {{ $paper['width_mm'] }}mm {{ $paper['height_mm'] ?? 297 }}mm; margin: {{ $kind === 'label_4x6' ? '0' : ($kind === 'receipt_80mm' ? '3mm' : '10mm') }}; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: 'Inter', 'Noto Sans Bengali', sans-serif; font-size: 10pt; color: #111; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page { page-break-after: always; break-after: page; }
.page:last-child { page-break-after: auto; break-after: auto; }
h1 { font-size: 16pt; margin: 0 0 4pt; }
.muted { color: #555; }
.small { font-size: 8pt; }
.bold { font-weight: 700; }
.right { text-align: right; }
.row { display: flex; justify-content: space-between; gap: 8pt; }
.logo { max-height: 40px; max-width: 160px; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 4pt 3pt; vertical-align: top; text-align: left; }
th { border-bottom: 1px solid #111; font-size: 8.5pt; }
td { border-bottom: 1px solid #ddd; }
.totals td { border: 0; padding: 2pt 3pt; }
.totals .grand td { border-top: 1px solid #111; font-weight: 700; font-size: 11pt; }
.box { border: 1px solid #111; padding: 6pt; }
.checkbox { display: inline-block; width: 10pt; height: 10pt; border: 1px solid #111; }
.footer { margin-top: 10pt; font-size: 8.5pt; color: #333; }
</style>
</head>
<body>
@yield('body')
</body>
</html>
