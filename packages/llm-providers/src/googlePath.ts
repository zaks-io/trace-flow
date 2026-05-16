const GOOGLE_MODEL_PATH_PATTERN = /\/models\/([^/:]+):/i;

/**
 * Google API URLs encode the requested model in the path:
 *   /v1beta/models/{model}:{action}
 * Required for embedContent and batchEmbedContents responses since those
 * don't include modelVersion in the response body.
 */
export function parseGoogleModelFromPath(path: string): string | undefined {
  const match = GOOGLE_MODEL_PATH_PATTERN.exec(path);
  return match?.[1];
}
