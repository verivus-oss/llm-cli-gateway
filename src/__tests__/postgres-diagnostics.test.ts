import { describe, expect, it } from "vitest";
import {
  POSTGRES_RECORDER_TARGET,
  postgresFailureMessage,
} from "../storage/postgres-diagnostics.js";

describe("opaque PostgreSQL health diagnostics", () => {
  it("does not copy DSN-derived error text into the health message", () => {
    const marker = "postgresql://user:secret@private-db.example/gateway";
    const message = postgresFailureMessage(new Error(`connect failed for ${marker}`));

    expect(message).toBe("PostgreSQL operation failed");
    expect(message).not.toContain(marker);
    expect(POSTGRES_RECORDER_TARGET).toBe("postgresql");
  });
});
