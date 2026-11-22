import QRCode from 'qrcode';

// Onboarding 08 "You're live" 52:765 QR card: generated client-side (pinned `qrcode`), never sent to a server.
export async function qrDataUrl(text: string, size = 512): Promise<string> {
  return QRCode.toDataURL(text, { width: size, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#111827', light: '#ffffff' } });
}

/** Triggers a PNG download of the QR for `value`. */
export async function downloadQr(value: string, filename = 'shop-qr.png'): Promise<void> {
  const url = await qrDataUrl(value, 1024);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
