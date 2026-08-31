/** Opaque identity used on health surfaces for every PostgreSQL subsystem. */
export const POSTGRES_RECORDER_TARGET = "postgresql";

/**
 * PostgreSQL connection errors can echo DSN-derived hosts, users, and socket
 * paths. Health and routine logs expose only a stable failure class.
 */
export function postgresFailureMessage(_error: unknown): string {
  return "PostgreSQL operation failed";
}
