'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';
import {
  DEFAULT_API_KEY_NAME,
  getPrimaryApiKey,
  sortApiKeys,
  type ApiKeyLike,
} from './useDefaultApiKey.shared';

const DEFAULT_API_KEY_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export function useDefaultApiKey<T extends ApiKeyLike>(
  apiKeys: readonly T[],
  enabled: boolean,
): {
  sortedApiKeys: T[];
  primaryApiKey: T | null;
  isCreatingDefaultKey: boolean;
  defaultKeyError: string | null;
} {
  const createApiKey = useMutation(api.apiKeys.create);
  const [isCreatingDefaultKey, setIsCreatingDefaultKey] = useState(false);
  const [defaultKeyError, setDefaultKeyError] = useState<string | null>(null);
  const hasAttemptedCreation = useRef(false);

  const sortedApiKeys = useMemo(() => sortApiKeys(apiKeys), [apiKeys]);
  const primaryApiKey = useMemo(() => getPrimaryApiKey(apiKeys), [apiKeys]);

  useEffect(() => {
    if (primaryApiKey) {
      hasAttemptedCreation.current = false;
      setDefaultKeyError(null);
    }
  }, [primaryApiKey]);

  useEffect(() => {
    if (!enabled || primaryApiKey || hasAttemptedCreation.current) {
      return;
    }

    hasAttemptedCreation.current = true;
    setIsCreatingDefaultKey(true);
    setDefaultKeyError(null);

    void createApiKey({
      expiresAt: Date.now() + DEFAULT_API_KEY_TTL_MS,
      name: DEFAULT_API_KEY_NAME,
    })
      .catch((error: unknown) => {
        hasAttemptedCreation.current = false;
        setDefaultKeyError(
          error instanceof Error ? error.message : 'Failed to create default API key',
        );
      })
      .finally(() => {
        setIsCreatingDefaultKey(false);
      });
  }, [createApiKey, enabled, primaryApiKey]);

  return {
    sortedApiKeys,
    primaryApiKey,
    isCreatingDefaultKey,
    defaultKeyError,
  };
}
