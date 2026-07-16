/**
 * Maximum content bytes in one conservative POSIX argv element.
 *
 * Linux with 4 KiB pages caps one argument, including its trailing NUL, at
 * 128 KiB. Keeping the final argument at or below 131,071 UTF-8 bytes prevents
 * the common synchronous `spawn E2BIG` failure. Other platform and aggregate
 * argv/environment limits can be lower, so native E2BIG errors are normalized
 * by {@link normalizeCliInputTooLargeError} as a second line of defense.
 */
export const MAX_CLI_ARG_UTF8_BYTES = 128 * 1024 - 1;

/**
 * Conservative aggregate process-input budgets.
 *
 * Linux normally exposes a 2 MiB ARG_MAX, so the gateway reserves half for
 * inherited environment and runtime overhead. Darwin and the BSD/SunOS/AIX
 * family receive the smaller portable budget. Windows uses UTF-8 bytes as a
 * deliberately conservative proxy for UTF-16 command-line units: UTF-8 is
 * never shorter for the caller-controlled values admitted here. cmd.exe has a
 * separate 8,191-character command-line boundary, so resolved .cmd/.bat
 * wrappers use the smaller composite budget after quoting and escaping.
 */
export const MAX_CLI_ARGV_UTF8_BYTES_LINUX = 1024 * 1024;
export const MAX_CLI_ARGV_UTF8_BYTES_POSIX = 128 * 1024;
export const MAX_CLI_ARGV_UTF8_BYTES_WINDOWS = 30_000;
export const MAX_CLI_ARGV_UTF8_BYTES_WINDOWS_CMD = 7_500;
/** Conservative proxy for the Windows process environment block. */
export const MAX_CLI_ENV_UTF8_BYTES_WINDOWS = 30_000;
/** Bound argv pointer-table overhead independently of encoded byte size. */
export const MAX_CLI_ARGV_ELEMENTS = 2_048;
/** Bound the combined argv and environment pointer table. */
export const MAX_CLI_PROCESS_ELEMENTS = 4_096;
/** Reserve for gateway PATH extension, isolation rewrites, and launcher bookkeeping. */
export const CLI_RUNTIME_ENV_HEADROOM_BYTES = 32 * 1024;
export const CLI_WINDOWS_RUNTIME_ENV_HEADROOM_BYTES = 4 * 1024;

export const CLI_INPUT_TOO_LARGE_CATEGORY = "input_too_large" as const;
export const CLI_INVALID_INPUT_CATEGORY = "invalid_input" as const;

export interface CliInputLimitContext {
  provider: string;
  inputName?: string;
  maxUtf8Bytes?: number;
}

export interface CliArgvLimitContext {
  provider: string;
  platform?: NodeJS.Platform;
  /**
   * Windows launch surface when it is already known. Leave undefined during
   * provider preparation so admission conservatively allows for an npm-style
   * .cmd/.bat shim. Pass false only after command resolution proves the final
   * process is native, or true for an already escaped cmd.exe composite.
   */
  windowsCommandWrapper?: boolean;
  maxUtf8Bytes?: number;
  inputName?: string;
}

export interface StdinPromptPlan {
  /** Provider-recognized argv marker that selects stdin as the prompt source. */
  argument: string;
  /** Exact caller input to write to the child, without truncation or rewriting. */
  stdin: string;
}

/** Codex exec and exec resume both define a literal `-` stdin prompt marker. */
export function planCodexStdinPrompt(prompt: string): StdinPromptPlan {
  return { argument: "-", stdin: prompt };
}

/**
 * Typed, non-retryable admission failure for a request that cannot fit in the
 * provider CLI's argv transport. The original input is never retained on the
 * error object or included in the message.
 */
export class CliInputTooLargeError extends Error {
  readonly code = "E2BIG";
  readonly errorCategory = CLI_INPUT_TOO_LARGE_CATEGORY;
  readonly retryable = false;

  constructor(
    readonly provider: string,
    readonly inputName: string,
    readonly actualUtf8Bytes: number | null,
    readonly maxUtf8Bytes: number | null,
    message?: string,
    options?: ErrorOptions
  ) {
    const measured =
      actualUtf8Bytes === null ? "the platform process limit" : `${actualUtf8Bytes} UTF-8 bytes`;
    const limit = maxUtf8Bytes === null ? "" : `; maximum ${maxUtf8Bytes} bytes`;
    super(
      message ??
        `${provider} ${inputName} is too large for the provider CLI argv transport (${measured}${limit}). ` +
          "The gateway will not truncate instructions. Shorten or split the input, or use a verified stdin, ACP, or HTTP provider transport.",
      options
    );
    this.name = "CliInputTooLargeError";
  }
}

/**
 * Typed, non-retryable rejection for a value that cannot be represented in a
 * native process command line. The rejected value is never retained on the
 * error object or interpolated into its public message.
 */
export class CliInvalidInputError extends Error {
  readonly code = "ERR_INVALID_ARG_VALUE";
  readonly errorCategory = CLI_INVALID_INPUT_CATEGORY;
  readonly retryable = false;
  readonly provider: string;
  readonly inputName: string;

  constructor(provider: string, inputName: string) {
    const safeProvider = safeAdmissionLabel(provider, "provider");
    const safeInputName = safeAdmissionLabel(inputName, "argv input");
    super(
      `${safeProvider} ${safeInputName} cannot be passed to the provider CLI because it contains an embedded NUL byte. Remove the NUL byte and retry.`
    );
    this.name = "CliInvalidInputError";
    this.provider = safeProvider;
    this.inputName = safeInputName;
  }
}

export type CliInputAdmissionError = CliInputTooLargeError | CliInvalidInputError;

/** True only for the gateway's privacy-safe, typed argv admission errors. */
export function isCliInputAdmissionError(error: unknown): error is CliInputAdmissionError {
  return error instanceof CliInputTooLargeError || error instanceof CliInvalidInputError;
}

function safeAdmissionLabel(value: string, fallback: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9 _./:[\]-]{0,127}$/.test(value) ? value : fallback;
}

/** Reject a value that Node cannot represent in command or argv. */
function assertCliArgRepresentable(value: string, context: CliInputLimitContext): void {
  if (!value.includes("\0")) return;
  throw new CliInvalidInputError(context.provider, context.inputName ?? "input");
}

/** Reject an argv element before spawn using its final encoded byte length. */
export function assertCliArgUtf8Size(value: string, context: CliInputLimitContext): void {
  assertCliArgRepresentable(value, context);
  const maxUtf8Bytes = context.maxUtf8Bytes ?? MAX_CLI_ARG_UTF8_BYTES;
  const actualUtf8Bytes = Buffer.byteLength(value, "utf8");
  if (actualUtf8Bytes <= maxUtf8Bytes) return;

  throw new CliInputTooLargeError(
    context.provider,
    context.inputName ?? "input",
    actualUtf8Bytes,
    maxUtf8Bytes
  );
}

/** Count the final command and argv bytes, including one terminator per token. */
export function measureCliArgvUtf8Bytes(command: string, args: readonly string[]): number {
  let total = Buffer.byteLength(command, "utf8") + 1;
  for (const argument of args) total += Buffer.byteLength(argument, "utf8") + 1;
  return total;
}

/** Count a merged process environment as `key=value\0` elements. */
export function measureCliEnvironmentUtf8Bytes(env: NodeJS.ProcessEnv): number {
  let total = 0;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    total += Buffer.byteLength(key, "utf8") + 1 + Buffer.byteLength(value, "utf8") + 1;
  }
  return total;
}

/**
 * Conservative upper bound for Node/libuv Windows command-line quoting.
 * Backslash runs before quotes or an argument's closing quote can double, and
 * every token can gain a surrounding quote pair plus a separator.
 */
export function measureWindowsCliArgvUtf8UpperBound(
  command: string,
  args: readonly string[]
): number {
  let total = Buffer.byteLength(command, "utf8") * 2 + 3;
  for (const argument of args) total += Buffer.byteLength(argument, "utf8") * 2 + 3;
  return total;
}

/**
 * Conservative pre-resolution upper bound for an npm-style .cmd/.bat shim.
 *
 * The final wrapper path is not available during pure provider preparation,
 * before filesystem artifacts and durable request state may be created. Each
 * token can first double under CommandLineToArgvW backslash/quote encoding and
 * then double again when cmd.exe metacharacters are caret-escaped. Fixed
 * headroom covers `cmd.exe /d /s /c`, separators, outer quoting, and a longer
 * resolved shim path. The exact escaped composite is checked again after
 * command resolution at the spawn chokepoint.
 */
export function measureWindowsCmdWrapperPreflightUtf8UpperBound(
  command: string,
  args: readonly string[]
): number {
  const wrapperAndResolvedPathHeadroom = 1_024;
  let total = wrapperAndResolvedPathHeadroom + Buffer.byteLength(command, "utf8") * 2;
  for (const argument of args) {
    // The surrounding quotes are themselves caret-escaped.
    total += 5;
    let backslashes = 0;
    for (const character of argument) {
      if (character === "\\") {
        backslashes += 1;
        continue;
      }
      if (character === '"') {
        // CommandLineToArgvW doubles the run and inserts one backslash;
        // cmd.exe then inserts a caret before the quote.
        total += backslashes * 2 + 3;
        backslashes = 0;
        continue;
      }
      total += backslashes;
      backslashes = 0;
      const codePoint = character.codePointAt(0) ?? 0;
      total += codePoint <= 0x7f ? 1 : Buffer.byteLength(character, "utf8");
      // Every cmd metacharacter is non-alphanumeric ASCII. Counting all such
      // punctuation except the known-safe path/assignment characters is a
      // tight upper bound without coupling this admission module to the
      // executor's exact escaping implementation.
      const safeAscii =
        (codePoint >= 0x30 && codePoint <= 0x39) ||
        (codePoint >= 0x41 && codePoint <= 0x5a) ||
        (codePoint >= 0x61 && codePoint <= 0x7a) ||
        "_./:=-".includes(character);
      if (codePoint <= 0x7f && !safeAscii) {
        total += 1;
      }
    }
    // A trailing run doubles before the closing quote.
    total += backslashes * 2;
  }
  return total;
}

/** Resolve the conservative aggregate budget for one final process surface. */
export function maxCliArgvUtf8Bytes(
  platform: NodeJS.Platform,
  windowsCommandWrapper = false
): number {
  if (platform === "win32") {
    return windowsCommandWrapper
      ? MAX_CLI_ARGV_UTF8_BYTES_WINDOWS_CMD
      : MAX_CLI_ARGV_UTF8_BYTES_WINDOWS;
  }
  if (platform === "linux" || platform === "android") {
    return MAX_CLI_ARGV_UTF8_BYTES_LINUX;
  }
  return MAX_CLI_ARGV_UTF8_BYTES_POSIX;
}

/** Reject an aggregate command plus argv before any process launch side effect. */
export function assertCliArgvUtf8Size(
  command: string,
  args: readonly string[],
  context: CliArgvLimitContext
): void {
  assertCliArgRepresentable(command, {
    provider: context.provider,
    inputName: "command",
  });
  for (const [index, argument] of args.entries()) {
    assertCliArgRepresentable(argument, {
      provider: context.provider,
      inputName: `argv[${index}]`,
    });
  }
  if (args.length > MAX_CLI_ARGV_ELEMENTS) {
    const inputName = context.inputName ?? "argv aggregate";
    throw new CliInputTooLargeError(
      context.provider,
      inputName,
      null,
      null,
      `${context.provider} ${inputName} has too many elements for the provider CLI argv transport (${args.length}; maximum ${MAX_CLI_ARGV_ELEMENTS}). Shorten or split the input, or use a verified stdin, ACP, or HTTP provider transport.`
    );
  }
  const platform = context.platform ?? process.platform;
  const unresolvedWindowsSurface =
    platform === "win32" && context.windowsCommandWrapper === undefined;
  const windowsCommandWrapper = context.windowsCommandWrapper ?? unresolvedWindowsSurface;
  const maxUtf8Bytes = context.maxUtf8Bytes ?? maxCliArgvUtf8Bytes(platform, windowsCommandWrapper);
  let actualUtf8Bytes: number;
  if (unresolvedWindowsSurface) {
    actualUtf8Bytes = measureWindowsCmdWrapperPreflightUtf8UpperBound(command, args);
  } else if (platform === "win32" && !windowsCommandWrapper) {
    actualUtf8Bytes = measureWindowsCliArgvUtf8UpperBound(command, args);
  } else {
    actualUtf8Bytes = measureCliArgvUtf8Bytes(command, args);
  }
  if (actualUtf8Bytes <= maxUtf8Bytes) return;

  throw new CliInputTooLargeError(
    context.provider,
    context.inputName ?? "argv aggregate",
    actualUtf8Bytes,
    maxUtf8Bytes
  );
}

/**
 * Admit the exact command, argv, and merged environment seen by spawn.
 * Environment values are measured but never retained or copied into errors.
 */
export function assertCliProcessInputUtf8Size(
  command: string,
  args: readonly string[],
  envOverrides: NodeJS.ProcessEnv | undefined,
  context: CliArgvLimitContext,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
  options: { reserveRuntimeHeadroom?: boolean } = {}
): void {
  assertCliArgvUtf8Size(command, args, context);
  const mergedEnv: NodeJS.ProcessEnv = { ...inheritedEnv, ...(envOverrides ?? {}) };
  const entries = Object.entries(mergedEnv).filter((entry): entry is [string, string] => {
    return entry[1] !== undefined;
  });
  for (const [key, value] of entries) {
    assertCliArgRepresentable(key, {
      provider: context.provider,
      inputName: "environment name",
    });
    assertCliArgRepresentable(value, {
      provider: context.provider,
      inputName: "environment value",
    });
    assertCliArgUtf8Size(`${key}=${value}`, {
      provider: context.provider,
      inputName: "environment element",
    });
  }
  if (args.length + entries.length > MAX_CLI_PROCESS_ELEMENTS) {
    throw new CliInputTooLargeError(
      context.provider,
      context.inputName ?? "argv and environment aggregate",
      null,
      null,
      `${context.provider} process input has too many argv and environment elements (${args.length + entries.length}; maximum ${MAX_CLI_PROCESS_ELEMENTS}). Shorten or split the input, or use a verified stdin, ACP, or HTTP provider transport.`
    );
  }
  if ((context.platform ?? process.platform) === "win32") {
    const environmentBytes = measureCliEnvironmentUtf8Bytes(mergedEnv);
    const environmentBudget =
      MAX_CLI_ENV_UTF8_BYTES_WINDOWS -
      (options.reserveRuntimeHeadroom === false ? 0 : CLI_WINDOWS_RUNTIME_ENV_HEADROOM_BYTES);
    if (environmentBytes <= environmentBudget) return;
    throw new CliInputTooLargeError(
      context.provider,
      context.inputName ?? "environment aggregate",
      environmentBytes,
      environmentBudget
    );
  }
  const maxUtf8Bytes =
    context.maxUtf8Bytes ?? maxCliArgvUtf8Bytes(context.platform ?? process.platform, false);
  const admittedUtf8Bytes = Math.max(
    1,
    maxUtf8Bytes - (options.reserveRuntimeHeadroom === false ? 0 : CLI_RUNTIME_ENV_HEADROOM_BYTES)
  );
  const actualUtf8Bytes =
    measureCliArgvUtf8Bytes(command, args) + measureCliEnvironmentUtf8Bytes(mergedEnv);
  if (actualUtf8Bytes <= admittedUtf8Bytes) return;
  throw new CliInputTooLargeError(
    context.provider,
    context.inputName ?? "argv and environment aggregate",
    actualUtf8Bytes,
    admittedUtf8Bytes
  );
}

/**
 * Walk a wrapped error chain without trusting arbitrary objects. Retry and
 * circuit-breaker layers retain native launch errors under `cause`.
 */
export function isNativeArgumentListTooLong(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof CliInputTooLargeError) return true;
    if (typeof current !== "object") return false;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === "E2BIG") return true;
    current = candidate.cause;
  }
  return false;
}

/** Convert a native or wrapped E2BIG into the stable public error contract. */
export function normalizeCliInputTooLargeError(
  error: unknown,
  context: Pick<CliInputLimitContext, "provider" | "inputName">
): CliInputTooLargeError | null {
  if (error instanceof CliInputTooLargeError) return error;
  if (!isNativeArgumentListTooLong(error)) return null;
  return new CliInputTooLargeError(context.provider, context.inputName ?? "argv", null, null);
}

/** Walk a wrapped launch error without copying Node's value-echoing message. */
export function isNativeInvalidCliArgument(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof CliInvalidInputError) return true;
    if (typeof current !== "object") return false;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === "ERR_INVALID_ARG_VALUE") return true;
    current = candidate.cause;
  }
  return false;
}

/** Convert native or typed argv admission errors into a safe public contract. */
export function normalizeCliInputAdmissionError(
  error: unknown,
  context: Pick<CliInputLimitContext, "provider" | "inputName">
): CliInputAdmissionError | null {
  if (isCliInputAdmissionError(error)) return error;
  if (isNativeInvalidCliArgument(error)) {
    return new CliInvalidInputError(context.provider, context.inputName ?? "argv");
  }
  return normalizeCliInputTooLargeError(error, context);
}
