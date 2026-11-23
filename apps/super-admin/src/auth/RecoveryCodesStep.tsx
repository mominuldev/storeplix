import { Button, Checkbox, copyText } from '@storeplix/ui';
import { Check, Copy, Download, KeyRound } from 'lucide-react';
import { useState } from 'react';
import { saveBlob } from '../lib/download';

// Composed from 44:4784 (P8-4): 10 single-use recovery codes, shown once; Copy / Download .txt; "I saved them".
export function RecoveryCodesStep({ codes, email, onDone }: { codes: string[]; email: string; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = [`Store Plix platform admin recovery codes for ${email}`, 'Each code works once.', '', ...codes].join('\n');

  return (
    <div className="flex flex-col gap-6">
      <span aria-hidden className="flex size-[52px] items-center justify-center rounded-lg bg-success-bg text-success">
        <KeyRound className="size-6" />
      </span>
      <div className="flex flex-col gap-1.5">
        <h1 className="text-heading-32 text-text-primary">Save your recovery codes</h1>
        <p className="text-body text-text-secondary">2FA is on. If you lose your phone, each of these codes signs you in once. They won’t be shown again.</p>
      </div>
      <ul aria-label="Recovery codes" className="grid grid-cols-2 gap-2 rounded-lg border border-border-default bg-surface-subtle p-4">
        {codes.map((c) => (
          <li key={c} className="font-mono text-body font-medium tracking-wider text-text-primary">
            {c}
          </li>
        ))}
      </ul>
      <div className="flex gap-3">
        <Button
          variant="secondary"
          className="flex-1"
          onClick={async () => {
            if (await copyText(codes.join('\n'))) setCopied(true);
          }}
        >
          {copied ? <Check aria-hidden className="size-4" /> : <Copy aria-hidden className="size-4" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button variant="secondary" className="flex-1" onClick={() => saveBlob(new Blob([text], { type: 'text/plain' }), 'storeplix-admin-recovery-codes.txt')}>
          <Download aria-hidden className="size-4" />
          Download .txt
        </Button>
      </div>
      <Checkbox label="I saved them somewhere safe" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
      <Button fullWidth disabled={!saved} onClick={onDone} className="min-h-11">
        Continue to Platform admin
      </Button>
    </div>
  );
}
