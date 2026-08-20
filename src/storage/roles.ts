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

export const STORAGE_OPERATION_CLASSES: readonly StorageOperationClass[] = [
  "write",
  "transcript_read",
  "analytics_read",
  "retention",
];

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
