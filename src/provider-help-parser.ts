/**
 * Provider help parser (phase-1b, runtime capability discovery).
 *
 * Parses a CLI `--help` text into a structured surface of flags + subcommands.
 * It is deliberately provider-AGNOSTIC: it handles the three help dialects the
 * gateway's providers emit today without any provider-name branching.
 *
 *   1. Rust/clap style (codex, grok):   `Options:` + `-c, --config <key=value>`,
 *      `[possible values: a, b, c]`, `[default: ...]`, `Commands:` for subcmds.
 *   2. Go `flag` style (agy):           `  --flag  Description`, enum via
 *      `<a|b|c>`/`[a|b|c]`, `Available subcommands:` for subcmds.
 *   3. Python argparse style (vibe-acp): `usage: ...`, `options:` + `-h, --help`.
 *
 * For every flag it infers: arity (none/one/many), a value type, enum values,
 * repeatability, a safety class, argv placement, and any aliases. For every
 * subcommand it captures name + one-line description + a help checksum.
 *
 * NEVER silently drop: anything that LOOKS like a flag declaration but cannot be
 * confidently mapped (e.g. a non-ASCII flag token) is emitted as a
 * `discovered-unmapped` record carrying the raw help excerpt, a checksum, and a
 * concrete reason. Downstream (schema-builder, discovery set) surfaces these as
 * evidence instead of hiding them.
 *
 * Pure/data-only: no process spawn, no I/O. `crypto` is used only for checksums.
 */

import { createHash } from "node:crypto";

/** Arity of a flag: takes no value, exactly one, or many (repeatable/variadic). */
export type ParsedFlagArity = "none" | "one" | "many";

/** Inferred value type of a flag argument. */
export type ParsedFlagValueType = "boolean" | "string" | "enum" | "number" | "unknown";

/**
 * Safety class inferred from the flag name/description. `dangerous` marks flags
 * whose upstream risk semantics disable safety rails (bypass, yolo, skip
 * permissions, disable sandbox, ...). `safe` is a confidently-parsed ordinary
 * flag. `unknown` is used when we parsed a flag but could not classify it.
 */
export type ParsedFlagSafety = "safe" | "dangerous" | "unknown";

/** How the flag + value are laid out in argv. */
export type ParsedArgvPlacement = "flag" | "flag-then-value";

/** A confidently-parsed flag. */
export interface ParsedFlag {
  /** Canonical (long, if present) flag token, e.g. `--model`. */
  readonly name: string;
  /** Other spellings for the same flag, e.g. `["-m"]`. */
  readonly aliases: readonly string[];
  readonly arity: ParsedFlagArity;
  readonly valueType: ParsedFlagValueType;
  readonly enumValues: readonly string[];
  readonly repeatable: boolean;
  readonly safety: ParsedFlagSafety;
  readonly argvPlacement: ParsedArgvPlacement;
  readonly description: string;
}

/** A parsed subcommand (name + one-line description + line checksum). */
export interface ParsedSubcommand {
  readonly name: string;
  readonly description: string;
  /** Checksum of the `name + description` declaration line. */
  readonly helpChecksum: string;
}

/**
 * Anything discovered that could not be confidently mapped. Carries the raw
 * excerpt, a checksum, and a concrete reason so it is auditable, never hidden.
 */
export interface DiscoveredUnmapped {
  /** What kind of surface this was: a flag, subcommand, ACP method, or model. */
  readonly kind: "flag" | "subcommand" | "acp-method" | "model";
  /** Raw help excerpt (a line or fragment) that triggered the record. */
  readonly raw: string;
  /** Checksum of `raw`. */
  readonly checksum: string;
  /** Concrete, human-readable mapping reason. */
  readonly reason: string;
}

/** The structured result of parsing one `--help` text. */
export interface ParsedHelp {
  readonly flags: readonly ParsedFlag[];
  readonly subcommands: readonly ParsedSubcommand[];
  readonly discoveredUnmapped: readonly DiscoveredUnmapped[];
  /** Checksum of the whole (trimmed) help text. */
  readonly checksum: string;
}

/** SHA-256 hex checksum of a UTF-8 string. Shared helper for the phase. */
export function checksumText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * A flag token like `-m`, `--model`, `--dry-run`. Must fully match: a leading
 * `-`/`--`, an ASCII letter, then ASCII alphanumerics/dashes. A declaration
 * whose leading token does not fully match is treated as unmapped, not silently
 * dropped.
 */
const FLAG_TOKEN = /^-{1,2}[a-zA-Z][a-zA-Z0-9-]*$/;

/** Keywords that classify a flag (by name or description) as dangerous. */
const DANGEROUS_KEYWORDS = [
  "dangerous",
  "bypass",
  "yolo",
  "skip-permission",
  "skip permissions",
  "skip-git",
  "no-sandbox",
  "without sandbox",
  "auto-approve",
  "always-approve",
  "disable-web-search",
  "force",
];

/** Value placeholders that read as a numeric argument. */
const NUMBER_PLACEHOLDERS =
  /^(n|num|count|number|seconds|secs|ms|port|size|turns|budget|price|tokens|max[-_]?turns)$/i;

/** Value placeholders that read as a path/file argument (still a string type). */
const PATH_PLACEHOLDERS = /^(file|files|dir|path|dir(ectory)?|glob)$/i;

/**
 * A subcommand declaration line inside a Commands section. Captures the leading
 * command NAME even when it is followed by usage arguments. clap/commander emit
 * `get <name>`, `login [options] <name>`, `add [options] <name> <cmd> [args...]`
 * with only a SINGLE space before the first usage token, so a name-then-2-spaces
 * rule would drop every arg-bearing subcommand. Usage tokens are the bracketed /
 * ellipsis forms only (`<...>`, `[...]`, `...`); a bare word after the name is
 * NOT a usage arg, so indented example lines such as
 * `claude mcp add --transport http ...` (single-spaced plain words, no 2-space
 * description gap) never match. The description, when present, is separated by
 * 2+ spaces; a bare command with no description matches at end-of-line. A leading
 * `-` never reaches here (those are parsed as flag declarations upstream).
 */
const SUBCOMMAND_LINE =
  /^([a-zA-Z][a-zA-Z0-9_-]*)((?:\s+(?:<[^<>]*>|\[[^[\]]*\]|\.\.\.))*)(?:\s{2,}(\S.*)?)?$/;

function isDangerous(name: string, description: string): boolean {
  const haystack = `${name} ${description}`.toLowerCase();
  return DANGEROUS_KEYWORDS.some(keyword => haystack.includes(keyword));
}

/**
 * Extract enum values from a declaration/description fragment. Handles both
 * `[possible values: a, b, c]` (clap) and inline `<a|b|c>` / `[a|b|c]`.
 */
function extractEnumValues(fragment: string): string[] {
  const possible = /\bpossible values:\s*([^\]\n]+)/i.exec(fragment);
  if (possible) {
    return possible[1]
      .split(",")
      .map(value => value.trim())
      .filter(value => value.length > 0);
  }
  const piped = /[<[]([a-zA-Z0-9._-]+(?:\s*\|\s*[a-zA-Z0-9._-]+)+)[\]>]/.exec(fragment);
  if (piped) {
    return piped[1]
      .split("|")
      .map(value => value.trim())
      .filter(value => value.length > 0);
  }
  return [];
}

/** Whether a declaration contains a value placeholder (`<X>`, `[X]`, `KEY=VALUE`). */
function hasValuePlaceholder(afterFlags: string): boolean {
  if (/[<[][^\]>]*[\]>]/.test(afterFlags)) return true;
  // Bare UPPER or key=value placeholders (some argparse/go help lines).
  if (/\b[A-Z][A-Z0-9_]{1,}\b/.test(afterFlags.split(/\s{2,}/, 1)[0] ?? "")) return true;
  if (/=/.test(afterFlags.split(/\s{2,}/, 1)[0] ?? "")) return true;
  return false;
}

/** Infer a value type from the placeholder + enum info. */
function inferValueType(placeholder: string, enumValues: readonly string[]): ParsedFlagValueType {
  if (enumValues.length > 0) return "enum";
  const inner = /[<[]([^\]>]+)[\]>]/.exec(placeholder)?.[1]?.trim() ?? placeholder.trim();
  const token = inner
    .replace(/\.\.\.$/, "")
    .replace(/[<>[\]]/g, "")
    .trim();
  if (token.length === 0) return "string";
  if (token.includes("=")) return "string";
  if (NUMBER_PLACEHOLDERS.test(token)) return "number";
  if (PATH_PLACEHOLDERS.test(token)) return "string";
  // A recognisable identifier-ish placeholder -> string. Anything with odd
  // characters we cannot classify -> unknown (routed to discovered-unmapped by
  // the schema builder, never a fabricated field).
  if (/^[a-zA-Z0-9_./|-]+$/.test(token)) return "string";
  return "unknown";
}

interface FlagDeclaration {
  readonly tokens: string[];
  readonly afterFlags: string;
  readonly description: string;
}

/**
 * Split a flag declaration line into leading flag tokens, the value-placeholder
 * remainder, and the trailing description. Returns null when the line does not
 * begin with a `-`.
 */
function splitFlagLine(line: string): FlagDeclaration | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("-")) return null;

  // clap/argparse separate declaration from description with 2+ spaces; go flag
  // style does the same. Split on the first run of 2+ spaces.
  const gap = /\s{2,}/.exec(trimmed);
  const declPart = gap ? trimmed.slice(0, gap.index) : trimmed;
  const description = gap ? trimmed.slice(gap.index).trim() : "";

  // Leading comma/space separated flag tokens, then the value placeholder.
  const pieces = declPart.split(/[,\s]+/).filter(Boolean);
  const tokens: string[] = [];
  let i = 0;
  for (; i < pieces.length; i++) {
    if (pieces[i].startsWith("-")) {
      tokens.push(pieces[i]);
    } else {
      break;
    }
  }
  const afterFlags = pieces.slice(i).join(" ");
  return { tokens, afterFlags, description };
}

/**
 * Parse a `--help` text. See the module comment for the supported dialects and
 * the never-silently-drop guarantee.
 */
export function parseHelpText(helpText: string): ParsedHelp {
  const normalized = helpText.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  const flags: ParsedFlag[] = [];
  const subcommands: ParsedSubcommand[] = [];
  const discoveredUnmapped: DiscoveredUnmapped[] = [];
  const seenFlagNames = new Set<string>();
  const seenSubcommands = new Set<string>();

  // Section tracking for subcommand blocks.
  let inSubcommandSection = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const lower = trimmed.toLowerCase();

    // Enter/leave a subcommands section.
    if (/^(commands|available subcommands|subcommands):$/.test(lower)) {
      inSubcommandSection = true;
      continue;
    }
    if (/^(options|arguments|flags):$/.test(lower) || lower.startsWith("usage")) {
      inSubcommandSection = false;
      // fallthrough: a usage line is not a flag declaration.
      if (lower.startsWith("usage")) continue;
      continue;
    }

    const decl = splitFlagLine(line);

    // Subcommand-section entries: `name [usage...]   description` (not starting
    // with `-`). Handles arg-bearing subcommands (`get <name>`, `login
    // [options] <name>`) whose usage arg is separated by a single space.
    if (inSubcommandSection && !decl) {
      const match = SUBCOMMAND_LINE.exec(trimmed);
      if (match) {
        const name = match[1];
        if (name === "help") continue;
        if (!seenSubcommands.has(name)) {
          seenSubcommands.add(name);
          const description = (match[3] ?? "").trim();
          subcommands.push({
            name,
            description,
            helpChecksum: checksumText(`${name}\t${description}`),
          });
        }
        continue;
      }
    }

    if (!decl) continue;

    // A line that begins with `-` but yields no valid leading flag token cannot
    // be mapped. Record it as evidence rather than dropping it.
    if (decl.tokens.length === 0 || !decl.tokens.every(token => FLAG_TOKEN.test(token))) {
      discoveredUnmapped.push({
        kind: "flag",
        raw: trimmed,
        checksum: checksumText(trimmed),
        reason:
          "help line begins with '-' but its leading token is not a parseable flag (non-ASCII or malformed flag name)",
      });
      continue;
    }

    // Canonical name: the first long flag if present, else the first token.
    const longFlag = decl.tokens.find(token => token.startsWith("--"));
    const name = longFlag ?? decl.tokens[0];
    const aliases = decl.tokens.filter(token => token !== name);

    if (seenFlagNames.has(name)) continue;
    seenFlagNames.add(name);

    // Collect enum info from the declaration line AND (clap style) the following
    // indented continuation lines, up to the next flag/blank/section.
    let enumSource = `${decl.afterFlags} ${decl.description}`;
    for (let j = index + 1; j < lines.length; j++) {
      const cont = lines[j];
      if (cont.trim().length === 0) break;
      const contDecl = splitFlagLine(cont);
      if (contDecl && contDecl.tokens.length > 0) break;
      enumSource += ` ${cont.trim()}`;
      if (/possible values:/i.test(cont)) break;
    }

    const enumValues = extractEnumValues(enumSource);
    const takesValue = hasValuePlaceholder(decl.afterFlags) || enumValues.length > 0;
    const repeatable =
      /\.\.\./.test(decl.afterFlags) ||
      /repeat/i.test(decl.description) ||
      /repeatable/i.test(enumSource);

    let arity: ParsedFlagArity;
    if (!takesValue) {
      arity = "none";
    } else if (repeatable) {
      arity = "many";
    } else {
      arity = "one";
    }

    const valueType: ParsedFlagValueType =
      arity === "none" ? "boolean" : inferValueType(decl.afterFlags, enumValues);

    const description = decl.description;
    const safety: ParsedFlagSafety = isDangerous(name, description) ? "dangerous" : "safe";

    flags.push({
      name,
      aliases,
      arity,
      valueType,
      enumValues,
      repeatable,
      safety,
      argvPlacement: arity === "none" ? "flag" : "flag-then-value",
      description,
    });
  }

  return {
    flags,
    subcommands,
    discoveredUnmapped,
    checksum: checksumText(normalized.trim()),
  };
}
