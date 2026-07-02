/**
 * Provider schema builder (phase-1b, runtime capability discovery).
 *
 * Turns a {@link DiscoveredCapabilitySet}'s MAPPED flags into request-field
 * descriptors that phase-4 will consume to build MCP tool input schemas. This
 * module does NOT register any MCP tool or build a Zod object itself (that is
 * phase-4, and requires an explicit surface reload / server restart) - it only
 * projects discovered flags into a typed, argv-aware descriptor list.
 *
 * A flag becomes a request field ONLY when its discovery metadata is complete:
 * a known arity, an inferable value type, and a safety class. Flags with an
 * `unknown` value type (a value placeholder the parser could not classify) are
 * routed to `discoveredUnmapped` descriptors with a checksum + reason, never a
 * fabricated request field. Parser-level unmapped records (malformed flag lines,
 * ACP extension methods) pass straight through.
 */

import type { CliType } from "./provider-definitions.js";
import type { DiscoveredCapabilitySet } from "./provider-capability-discovery.js";
import {
  checksumText,
  type DiscoveredUnmapped,
  type ParsedArgvPlacement,
  type ParsedFlag,
  type ParsedFlagSafety,
} from "./provider-help-parser.js";

/** Zod-able type of a discovered request field. */
export type RequestFieldZodType = "boolean" | "string" | "number" | "enum" | "string-array";

/** A discovered, safely-mapped request-field descriptor (phase-4 input). */
export interface RequestFieldDescriptor {
  /** camelCase field name derived from the flag (e.g. `--fork-session` -> `forkSession`). */
  readonly name: string;
  /** The upstream CLI flag this field emits, e.g. `--model`. */
  readonly flag: string;
  readonly aliases: readonly string[];
  readonly zodType: RequestFieldZodType;
  readonly enumValues: readonly string[];
  readonly repeatable: boolean;
  readonly argvPlacement: ParsedArgvPlacement;
  readonly safety: ParsedFlagSafety;
  readonly description: string;
}

/** The schema projection for one provider. */
export interface ProviderSchemaProjection {
  readonly providerId: CliType;
  readonly fields: readonly RequestFieldDescriptor[];
  readonly discoveredUnmapped: readonly DiscoveredUnmapped[];
}

/** Derive a camelCase field name from a flag token. */
export function flagToFieldName(flag: string): string {
  const stripped = flag.replace(/^-+/, "");
  return stripped
    .split(/[-_]/)
    .filter(Boolean)
    .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("");
}

function zodTypeForFlag(flag: ParsedFlag): RequestFieldZodType | null {
  if (flag.arity === "none") return "boolean";
  if (flag.valueType === "unknown") return null;
  if (flag.valueType === "enum") return flag.arity === "many" ? "string-array" : "enum";
  if (flag.arity === "many" || flag.repeatable) return "string-array";
  if (flag.valueType === "number") return "number";
  return "string";
}

/**
 * Build the request-field projection for a discovered set. Mapped flags become
 * {@link RequestFieldDescriptor}s; incomplete-metadata flags and all pre-existing
 * discovered-unmapped records (help-parser + ACP extension methods) are surfaced
 * as evidence.
 */
export function buildProviderSchema(set: DiscoveredCapabilitySet): ProviderSchemaProjection {
  const fields: RequestFieldDescriptor[] = [];
  const unmapped: DiscoveredUnmapped[] = [...set.discoveredUnmapped];
  const seen = new Set<string>();

  for (const flag of set.rootHelp.flags) {
    const zodType = zodTypeForFlag(flag);
    if (zodType === null) {
      unmapped.push({
        kind: "flag",
        raw: `${flag.name} ${flag.description}`.trim(),
        checksum: checksumText(`${flag.name} ${flag.description}`.trim()),
        reason:
          "flag takes a value but its type could not be inferred (arity/type/safety incomplete); exposed as discovered-unmapped rather than a request field",
      });
      continue;
    }
    const name = flagToFieldName(flag.name);
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    fields.push({
      name,
      flag: flag.name,
      aliases: flag.aliases,
      zodType,
      enumValues: flag.enumValues,
      repeatable: flag.repeatable,
      argvPlacement: flag.argvPlacement,
      safety: flag.safety,
      description: flag.description,
    });
  }

  return { providerId: set.providerId, fields, discoveredUnmapped: unmapped };
}
