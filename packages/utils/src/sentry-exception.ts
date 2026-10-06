import * as Sentry from '@sentry/cloudflare';

interface SafeExceptionDetails {
  message: string;
  operation: string;
  /** Callers supply static classifications and explicitly selected non-sensitive fields. */
  diagnostics?: {
    type: string;
    context: Record<string, string | number | boolean | undefined>;
    stackFilenames: readonly string[];
  };
}

function safeStackFrames(event: Sentry.Event, filenames: readonly string[]): Sentry.StackFrame[] {
  const frames = event.exception?.values?.at(-1)?.stacktrace?.frames ?? [];
  return frames.flatMap((frame) => {
    const filename = frame.filename?.split(/[?#]/, 1)[0]?.split(/[\\/]/).at(-1);
    if (!filename || !filenames.includes(filename)) return [];
    if (!Number.isSafeInteger(frame.lineno) || frame.lineno! < 1) return [];
    return [
      {
        filename,
        lineno: frame.lineno,
        ...(Number.isSafeInteger(frame.colno) && frame.colno! >= 0 ? { colno: frame.colno } : {}),
      },
    ];
  });
}

/** Capture the original object once; only explicit diagnostics may survive error scrubbing. */
export function captureSafeException(error: unknown, details: SafeExceptionDetails): void {
  Sentry.withScope((scope) => {
    scope.addEventProcessor((event) => {
      const diagnostics = details.diagnostics;
      const frames = diagnostics ? safeStackFrames(event, diagnostics.stackFilenames) : [];
      return {
        ...event,
        exception: {
          values: [
            {
              type: diagnostics?.type ?? 'Error',
              value: details.message,
              ...(frames.length > 0 ? { stacktrace: { frames } } : {}),
            },
          ],
        },
        message: undefined,
        logentry: undefined,
        threads: undefined,
        extra: diagnostics?.context,
        breadcrumbs: undefined,
        tags: { ...event.tags, operation: details.operation },
        fingerprint: diagnostics
          ? [details.operation, diagnostics.type, details.message]
          : [details.operation],
      };
    });
    scope.captureException(error);
  });
}
