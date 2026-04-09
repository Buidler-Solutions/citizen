'use client';

import { useState } from 'react';

type CopyableHashProps = {
  value: string | undefined;
  preview: string;
  label: string;
};

export default function CopyableHash({ value, preview, label }: CopyableHashProps) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    if (!value) return;

    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  return (
    <span className="copy-inline">
      <span className="mono" title={value ?? 'N/A'}>
        {preview}
      </span>
      <button
        type="button"
        className="copy-button"
        onClick={onCopy}
        disabled={!value}
        aria-label={value ? `Copy ${label}` : `${label} unavailable`}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}
