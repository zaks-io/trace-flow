'use client';

import { cn } from '@/lib/utils';

interface EmailContactLinkProps {
  localPart: string;
  domainParts: [string, string];
  label: string;
  obfuscatedText?: string;
  className?: string;
}

const AT_SYMBOL = String.fromCharCode(64);
const DOT_SYMBOL = String.fromCharCode(46);

export function EmailContactLink({
  localPart,
  domainParts,
  label,
  obfuscatedText,
  className,
}: EmailContactLinkProps) {
  const emailAddress = `${localPart}${AT_SYMBOL}${domainParts[0]}${DOT_SYMBOL}${domainParts[1]}`;
  const visibleText =
    obfuscatedText ?? `${localPart} [at] ${domainParts[0]} [dot] ${domainParts[1]}`;

  const openEmailClient = () => {
    window.location.href = `mailto:${emailAddress}`;
  };

  return (
    <button
      type="button"
      className={cn('inline-flex items-center underline underline-offset-4', className)}
      onClick={openEmailClient}
      aria-label={label}
    >
      {visibleText}
    </button>
  );
}
