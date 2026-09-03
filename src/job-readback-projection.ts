/** Host-local fields carried by complete job evidence. */
interface JobReadbackWithHostEvidence {
  executionContext?: unknown;
  nativeTranscript?: unknown;
  nativeTranscriptOffsetChars?: unknown;
  nativeTranscriptTotalChars?: unknown;
  nativeTranscriptNextOffsetChars?: unknown;
  nativeTranscriptPageTruncated?: unknown;
  providerSessionId?: unknown;
}

/**
 * Apply the caller boundary to any job snapshot or result.
 *
 * Remote callers never receive replay paths, provider-native transcripts, or
 * native continuation handles. Local result callers receive the native
 * transcript only when their tool explicitly selected raw output. Returning a
 * shallow copy before deleting fields prevents one read from mutating the
 * manager's in-memory record or another caller's response.
 */
export function projectJobReadback<T extends JobReadbackWithHostEvidence>(
  value: T,
  options: { remote: boolean; includeNativeTranscript?: boolean }
): T {
  const includeNativeTranscript = options.includeNativeTranscript ?? true;
  if (!options.remote && includeNativeTranscript) return value;

  const projected = { ...value };
  if (options.remote) {
    delete projected.executionContext;
    delete projected.providerSessionId;
  }
  if (options.remote || !includeNativeTranscript) {
    delete projected.nativeTranscript;
    delete projected.nativeTranscriptOffsetChars;
    delete projected.nativeTranscriptTotalChars;
    delete projected.nativeTranscriptNextOffsetChars;
    delete projected.nativeTranscriptPageTruncated;
  }
  return projected;
}
