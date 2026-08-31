/**
 * How a DSN-derived value is written into a line a human reads.
 *
 * Extracted from `flight-recorder-pg.ts`, where it was private, because a
 * SECOND consumer was found printing the same class of value with no control at
 * all: `evaluateTranscriptAdmission` interpolated its resolved host straight
 * into a refusal string, and three measured DSN shapes put a complete password
 * there. Two printers of one kind of value is how one of them stays unguarded,
 * so there is now one control and both call it.
 *
 * It is a DISPLAY control and not a secrecy control. It bounds length, escapes
 * what would break or reorder the line, and quotes what would otherwise read as
 * structure. It cannot decide whether a value IS a secret, and nothing here
 * should be read as claiming it does: keeping secrets out of the value is the
 * job of the gate that runs first (`admitPgDsn`) and of projecting the report
 * from a shape with no password field (`PgPublicTarget`).
 */

export const MAX_FIELD_CHARS = 120;

/**
 * Characters that BREAK, REORDER or COMMAND when a log line is rendered.
 *
 * Defined by PROPERTY, and round 10 proved the first property was the wrong
 * one. An enumerated bidi range missed U+009B CSI (`CSI 2J` erases a terminal
 * screen, and this string goes to stderr) and U+061C. Naming
 * `\p{Bidi_Control}` fixed those and still passed U+00AD SOFT HYPHEN, U+034F,
 * U+070F, U+2060, U+FE0F and U+E0061.
 *
 * The class those all belong to is INVISIBLE OR CONTROLLING, which Unicode
 * already names: `\p{Cf}` (format characters, which is every bidi control,
 * the zero-width joiners, the Arabic and Syriac marks and the interlinear
 * annotations) and `\p{Default_Ignorable_Code_Point}` (soft hyphen, variation
 * selectors, tag characters). Plus the C1 block and DEL, which JSON leaves raw
 * because it escapes C0 only.
 *
 * COST, stated because it is real: a database name legitimately containing a
 * zero-width joiner (an emoji sequence) is now shown escaped. That is the
 * right trade for a diagnostic line whose whole purpose is to be believed.
 */
const UNSAFE_IN_A_LOG_LINE =
  /[\u0080-\u009F\u007F\u2028\u2029]|\p{Cf}|\p{Default_Ignorable_Code_Point}/gu;

/** No format vocabulary: for a caller whose message already delimits the value. */
const NO_KEYWORDS: ReadonlySet<string> = new Set();

/**
 * A field value, left bare only when it is plainly a host, path, port or name.
 *
 * `formatKeywords` is the CALLER'S vocabulary, not a shared list, because it
 * describes that caller's line format and nothing else. `redactDsn` writes
 * `postgresql host H port P database D`, so a value equal to `port` reads as a
 * delimiter there and must be quoted; a caller whose message already wraps the
 * value in quotes has no such collision and passes nothing.
 */
export function showLogField(
  value: string,
  formatKeywords: ReadonlySet<string> = NO_KEYWORDS
): string {
  // A long value is truncated BEFORE quoting: pg imposes no length limit worth
  // relying on here, and a health line is read by a human, not parsed.
  // BY CODE POINT, not by UTF-16 code unit. Round 10: a 120-character value
  // ending in an emoji is 121 units, so slicing at 120 SEVERED THE SURROGATE
  // PAIR and the suffix then called 121 units "chars". Array spread iterates
  // code points, so neither can happen.
  const points = [...value];
  const bounded =
    points.length > MAX_FIELD_CHARS
      ? `${points.slice(0, MAX_FIELD_CHARS).join("")}... (${points.length} chars)`
      : value;
  // `://` is quoted even though every character in it is bare-word legal. Round
  // 24 moved the host from a shape allowlist to pg's own resolution, and pg
  // resolves `?host=evil://host` to exactly that. Naming it is correct; letting
  // it out UNQUOTED would emit a line shaped like a DSN, which is the property
  // this function is here to hold.
  if (
    /^[A-Za-z0-9._:/[\]-]+$/.test(bounded) &&
    !bounded.includes("://") &&
    !formatKeywords.has(bounded.toLowerCase())
  ) {
    return bounded;
  }
  return JSON.stringify(bounded).replace(UNSAFE_IN_A_LOG_LINE, c => {
    // codePointAt, not charCodeAt. Round 11 BLOCKER, codex: the pattern matches
    // a whole code point but this emitted only its HIGH SURROGATE, so U+E0061
    // and U+E0062 both rendered as `\udb40` and two different databases
    // produced identical reports. A line whose job is to name the target must
    // not collapse two targets into one string.
    const point = c.codePointAt(0) ?? 0;
    return point > 0xffff
      ? `\\u{${point.toString(16).padStart(5, "0")}}`
      : `\\u${point.toString(16).padStart(4, "0")}`;
  });
}
