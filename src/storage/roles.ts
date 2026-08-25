/**
 * Operation-to-role routing for the storage port.
 *
 * The security design requires distinct database identities rather than one
 * connection string, so every port operation declares what class of work it is
 * and the driver routes it to the matching credential. See
 * docs/plans/storage-unification.md section 3.1 and
 * docs/plans/postgres-security-hardening.md section 4.3.
 */

/** What class of work an operation is. Declared per operation, never inferred. */
export type StorageOperationClass =
  /** Any mutation of durable state. */
  | "write"
  /** A read that can return prompt, response or system text. */
  | "transcript_read"
  /** An aggregate read that must never return body text. */
  | "analytics_read"
  /** Scheduled deletion or eviction. */
  | "retention";

/**
 * Runtime credentials a driver may hold.
 *
 * `migrate` is deliberately absent. It is a member of the table-owning role and
 * exists for `npm run migrate` only; a long-running gateway process must not
 * hold owner-equivalent credentials, and DDL is not a routed runtime operation.
 * The migrate credential is process-separated, so adding it here would be a
 * privilege regression, not a feature.
 */
export type StorageRole = "app" | "reader" | "analytics" | "retention";

export const STORAGE_ROLES: readonly StorageRole[] = ["app", "reader", "analytics", "retention"];

/**
 * Per-role connection strings. A role with no DSN is simply not held.
 *
 * Declared here rather than in the Postgres driver because `[persistence.roles]`
 * in `config.ts` is what produces one, and config must not import a driver to
 * name the shape of its own output.
 */
export type StorageRoleDsns = Partial<Record<StorageRole, string>>;

export const STORAGE_OPERATION_CLASSES: readonly StorageOperationClass[] = [
  "write",
  "transcript_read",
  "analytics_read",
  "retention",
];

/**
 * The classes that only ever read. Declared once here, beside the class list,
 * because both drivers need it and both had their own answer: sqlite.ts kept a
 * `READ_ONLY_OPERATIONS` set and postgres.ts inlined
 * `operation === "transcript_read" || operation === "analytics_read"`. Two
 * copies of one fact is how a class added to one engine's rules and not the
 * other's becomes a write on a reader credential.
 */
export const READ_ONLY_OPERATION_CLASSES: ReadonlySet<StorageOperationClass> = new Set([
  "transcript_read",
  "analytics_read",
]);

/** The credential each operation class wants when the deployment provides it. */
const PREFERRED_ROLE: Readonly<Record<StorageOperationClass, StorageRole>> = {
  write: "app",
  transcript_read: "reader",
  analytics_read: "analytics",
  retention: "retention",
};

export interface RoleResolution {
  /** The credential the driver should use. */
  role: StorageRole;
  /**
   * Set when the preferred credential was not configured and the operation fell
   * back to `app`. Reported rather than silent: falling back to `app` widens
   * privilege, so a health surface must be able to say the separation is not
   * actually in force.
   */
  degradedFrom?: StorageRole;
}

/**
 * Route one operation to a configured credential.
 *
 * A deployment that configures only `app` keeps working exactly as it does
 * today, with every operation degraded onto that single identity.
 */
export function resolveStorageRole(
  operation: StorageOperationClass,
  configured: ReadonlySet<StorageRole>
): RoleResolution {
  // An unrecognised class used to fall straight through: the lookup yielded
  // undefined, `configured.has(undefined)` was false, and the result was
  // `{ role: "app", degradedFrom: undefined }`. That routes to the WIDEST
  // credential while reporting that separation is in force, which is the one
  // answer this function must never give. Fail closed instead.
  //
  // `StorageOperationClass` is a closed union, so typed callers cannot reach
  // this; it is reachable from untyped JavaScript, and s9 makes role
  // separation something a health surface asserts on top of this primitive.
  //
  // `Object.hasOwn`, not `!== undefined`: a bare undefined-check still admits
  // inherited keys, and `PREFERRED_ROLE["__proto__"]` evaluates to
  // Object.prototype rather than undefined. That one walked straight past the
  // first version of this guard.
  if (!Object.hasOwn(PREFERRED_ROLE, operation)) {
    throw new Error(
      `storage: unknown operation class ${JSON.stringify(operation)}; ` +
        `expected one of ${STORAGE_OPERATION_CLASSES.join(", ")}`
    );
  }
  const preferred = PREFERRED_ROLE[operation];
  if (configured.has(preferred)) return { role: preferred };
  if (configured.has("app")) return { role: "app", degradedFrom: preferred };
  throw new Error(
    `storage: no credential for ${operation} (wanted "${preferred}", and "app" is not configured either)`
  );
}

/** True when every operation class has its own credential. */
export function roleSeparationInForce(configured: ReadonlySet<StorageRole>): boolean {
  return STORAGE_OPERATION_CLASSES.every(
    op => resolveStorageRole(op, configured).degradedFrom === undefined
  );
}
