/**
 * s3 of docs/plans/storage-unification.dag.toml: the operation-to-role routing
 * seam. The security design's role separation is unimplementable without it,
 * so these assert the two properties it actually depends on: a deployment that
 * configures nothing keeps working, and one that configures roles genuinely
 * uses them rather than quietly falling back to the write credential.
 */
import { describe, expect, it } from "vitest";
import {
  resolveStorageRole,
  roleSeparationInForce,
  STORAGE_OPERATION_CLASSES,
  STORAGE_ROLES,
  type StorageRole,
} from "../storage/roles.js";
import { STATE_INVENTORY } from "../storage/store.js";

const set = (...roles: StorageRole[]): ReadonlySet<StorageRole> => new Set(roles);

describe("storage role routing", () => {
  it("routes each operation class to its own credential when configured", () => {
    const all = set("app", "reader", "analytics", "retention");

    expect(resolveStorageRole("write", all)).toEqual({ role: "app" });
    expect(resolveStorageRole("transcript_read", all)).toEqual({ role: "reader" });
    expect(resolveStorageRole("analytics_read", all)).toEqual({ role: "analytics" });
    expect(resolveStorageRole("retention", all)).toEqual({ role: "retention" });
  });

  it("degrades an app-only deployment to today's single identity", () => {
    const appOnly = set("app");

    for (const op of STORAGE_OPERATION_CLASSES) {
      expect(resolveStorageRole(op, appOnly).role).toBe("app");
    }
  });

  it("REPORTS the degradation rather than hiding it", () => {
    // Falling back to `app` widens privilege. A health surface has to be able
    // to say the separation is not in force, or a half-configured deployment
    // looks identical to a fully separated one.
    const appOnly = set("app");

    expect(resolveStorageRole("transcript_read", appOnly)).toEqual({
      role: "app",
      degradedFrom: "reader",
    });
    expect(roleSeparationInForce(appOnly)).toBe(false);
    expect(roleSeparationInForce(set("app", "reader", "analytics", "retention"))).toBe(true);
  });

  it("degrades per operation, so a partly configured deployment is partly separated", () => {
    const partial = set("app", "reader");

    expect(resolveStorageRole("transcript_read", partial)).toEqual({ role: "reader" });
    expect(resolveStorageRole("analytics_read", partial)).toEqual({
      role: "app",
      degradedFrom: "analytics",
    });
    expect(roleSeparationInForce(partial)).toBe(false);
  });

  it("throws rather than inventing a credential when app is absent", () => {
    // Silently proceeding with no credential is the one outcome that must not
    // happen: it would mean an operation ran under whatever the driver had.
    expect(() => resolveStorageRole("write", set("reader"))).toThrow(/no credential for write/);
    expect(() => resolveStorageRole("analytics_read", set())).toThrow(/analytics/);
  });

  it("has no migrate role, because the gateway must not hold owner credentials", () => {
    // Revision 3 of the design put migrate in the runtime pool set and was
    // corrected. Encoding it here so it cannot drift back in.
    expect(STORAGE_ROLES).not.toContain("migrate" as StorageRole);
    expect(STORAGE_ROLES).toEqual(["app", "reader", "analytics", "retention"]);
  });

  it("routes every declared operation class, with no unroutable gap", () => {
    const all = set("app", "reader", "analytics", "retention");
    const routed = STORAGE_OPERATION_CLASSES.map(op => resolveStorageRole(op, all).role);

    // Every class routes, and each to a DISTINCT credential: two classes
    // sharing one role would make the separation decorative.
    expect(routed).toHaveLength(STORAGE_OPERATION_CLASSES.length);
    expect(new Set(routed).size).toBe(STORAGE_OPERATION_CLASSES.length);
  });
});

describe("state inventory", () => {
  it("records a determination for every group, and a reason for each omission", () => {
    expect(STATE_INVENTORY.length).toBeGreaterThanOrEqual(13);
    for (const group of STATE_INVENTORY) {
      if (!group.inPort) {
        expect(group.note, `${group.id} omitted without a recorded reason`).toBeTruthy();
      }
    }
  });

  it("carries the state the design's earlier revisions kept forgetting", () => {
    const ids = new Set(STATE_INVENTORY.filter(g => g.inPort).map(g => g.id));

    // Revision 2 called its list complete while omitting these three.
    expect(ids).toContain("approvals");
    expect(ids).toContain("admin_audit");
    expect(ids).toContain("workspace_registry");
    // And the two that exist in SQLite only, which is the original defect.
    expect(ids).toContain("requests");
    expect(ids).toContain("gateway_metadata");
  });
});
