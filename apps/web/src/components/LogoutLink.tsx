'use client';

import type { AnchorHTMLAttributes } from 'react';
import { clearAuthenticatedCaches } from '@/components/providers/query-cache';

export function LogoutLink({ onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      {...props}
      href="/auth/logout"
      onClick={(event) => {
        clearAuthenticatedCaches();
        onClick?.(event);
      }}
    />
  );
}
