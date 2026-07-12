import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

const entrypoint = join(process.cwd(), "dist", "index.js");

describe.skipIf(!existsSync(entrypoint))("CLI metadata entrypoint", () => {
  function run(args: string[]) {
    return spawnSync(process.execPath, [entrypoint, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        LLM_GATEWAY_LOGS_DB: "none",
        LLM_GATEWAY_JOBS_DB: "none",
      },
    });
  }

  it("--version prints only the package version", () => {
    const result = run(["--version"]);
    expect(result.status).toBe(0);
    // Bare version, nothing else: a stable x.y.z or an x.y.z-<prerelease> cut
    // (e.g. 2.14.0-rc.1). The strict prerelease shape matches sync-site-version.mjs.
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/);
    expect(result.stderr).toBe("");
  });

  it("contracts --json prints machine-readable JSON without startup logs", () => {
    const result = run(["contracts", "--json"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: "upstream-cli-contracts.v1",
    });
  });

  it("exits cleanly when its stdio MCP client closes stdin", () => {
    const result = spawnSync(process.execPath, [entrypoint], {
      encoding: "utf8",
      input: "",
      timeout: 15_000,
      env: {
        ...process.env,
        LLM_GATEWAY_LOGS_DB: "none",
        LLM_GATEWAY_JOBS_DB: "none",
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
  });

  it("fails startup when a configured durable store cannot be opened", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-unavailable-postgres-"));
    const config = join(dir, "config.toml");
    writeFileSync(
      config,
      [
        "[persistence]",
        'backend = "postgres"',
        'dsn = "postgresql://127.0.0.1:1/unavailable"',
      ].join("\n")
    );
    try {
      const result = spawnSync(process.execPath, [entrypoint], {
        encoding: "utf8",
        input: "",
        timeout: 15_000,
        env: {
          ...process.env,
          LLM_GATEWAY_CONFIG: config,
          LLM_GATEWAY_LOGS_DB: "",
          LLM_GATEWAY_JOBS_DB: "",
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/durable job store|durable async persistence/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!existsSync(entrypoint))("CLI oauth client + connector setup", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function freshConfig(body = '[persistence]\nbackend = "sqlite"\n'): string {
    const dir = mkdtempSync(join(tmpdir(), "cli-oauth-"));
    dirs.push(dir);
    const cfg = join(dir, "config.toml");
    writeFileSync(cfg, body, "utf8");
    return cfg;
  }

  function run(args: string[], extraEnv: Record<string, string> = {}) {
    return spawnSync(process.execPath, [entrypoint, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        LLM_GATEWAY_LOGS_DB: "none",
        LLM_GATEWAY_JOBS_DB: "none",
        ...extraEnv,
      },
    });
  }

  it("oauth client add rejects a scheme-less redirect URI before writing config", () => {
    const cfg = freshConfig();
    const result = run(["oauth", "client", "add", "chatgpt", "--redirect-uri", "chatgpt.com/cb"], {
      LLM_GATEWAY_CONFIG: cfg,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/redirect-uri/i);
    // Config must be untouched (no client written).
    expect(readFileSync(cfg, "utf8")).not.toContain("client_id");
  });

  it("oauth client add rejects an unsafe client id before writing config", () => {
    const cfg = freshConfig();
    const result = run(
      ["oauth", "client", "add", "bad id;rm -rf", "--redirect-uri", "https://chatgpt.com/cb"],
      { LLM_GATEWAY_CONFIG: cfg }
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/client-id/i);
    expect(readFileSync(cfg, "utf8")).not.toContain("client_secret_hash");
  });

  it("oauth client add rejects an http non-loopback redirect URI (matches runtime policy)", () => {
    const cfg = freshConfig();
    const result = run(
      ["oauth", "client", "add", "chatgpt", "--redirect-uri", "http://evil.example.com/cb"],
      { LLM_GATEWAY_CONFIG: cfg }
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/https|loopback|localhost/i);
    expect(readFileSync(cfg, "utf8")).not.toContain("client_id");
  });

  it("oauth client add accepts an http localhost redirect URI (local testing)", () => {
    const cfg = freshConfig();
    const result = run(
      ["oauth", "client", "add", "localtest", "--redirect-uri", "http://localhost:8080/cb"],
      { LLM_GATEWAY_CONFIG: cfg }
    );
    expect(result.status).toBe(0);
    expect(readFileSync(cfg, "utf8")).toContain("localtest");
  });

  it("oauth client add prints the copy-once secret only with --print-once", () => {
    const cfg = freshConfig();
    const noFlag = run(
      ["oauth", "client", "add", "chatgpt", "--redirect-uri", "https://chatgpt.com/cb"],
      { LLM_GATEWAY_CONFIG: cfg }
    );
    expect(noFlag.status).toBe(0);
    expect(noFlag.stdout).not.toContain("client_secret");

    const cfg2 = freshConfig();
    const withFlag = run(
      [
        "oauth",
        "client",
        "add",
        "chatgpt",
        "--redirect-uri",
        "https://chatgpt.com/cb",
        "--print-once",
      ],
      { LLM_GATEWAY_CONFIG: cfg2 }
    );
    const packet = JSON.parse(withFlag.stdout);
    expect(packet.client_secret).toBeTruthy();
    expect(packet.client_secret_copy_once).toBe(true);
    // The plaintext secret is never persisted; only the scrypt hash is.
    const stored = readFileSync(cfg2, "utf8");
    expect(stored).toContain("client_secret_hash");
    expect(stored).not.toContain(packet.client_secret);
  });

  it("oauth client add refuses a duplicate client id (must rotate/revoke)", () => {
    const cfg = freshConfig();
    const first = run(
      ["oauth", "client", "add", "chatgpt", "--redirect-uri", "https://chatgpt.com/cb"],
      { LLM_GATEWAY_CONFIG: cfg }
    );
    expect(first.status).toBe(0);
    const dup = run(
      ["oauth", "client", "add", "chatgpt", "--redirect-uri", "https://chatgpt.com/cb"],
      { LLM_GATEWAY_CONFIG: cfg }
    );
    expect(dup.status).not.toBe(0);
    expect(dup.stderr).toMatch(/already exists/i);
  });

  it("oauth client rotate distinguishes the new copy-once secret from stored redacted metadata", () => {
    const cfg = freshConfig();
    run(["oauth", "client", "add", "chatgpt", "--redirect-uri", "https://chatgpt.com/cb"], {
      LLM_GATEWAY_CONFIG: cfg,
    });
    const rotated = run(["oauth", "client", "rotate", "chatgpt", "--print-once"], {
      LLM_GATEWAY_CONFIG: cfg,
    });
    const packet = JSON.parse(rotated.stdout);
    expect(packet.client_secret).toBeTruthy();
    expect(packet.client.secret_configured).toBe(true);
    // Stored metadata is redacted: no hash or plaintext in the client sub-object.
    expect(JSON.stringify(packet.client)).not.toContain("scrypt:");
    expect(JSON.stringify(packet.client)).not.toContain(packet.client_secret);
  });

  it("oauth client list shows redacted metadata only (no secret or hash)", () => {
    const cfg = freshConfig();
    run(
      [
        "oauth",
        "client",
        "add",
        "chatgpt",
        "--redirect-uri",
        "https://chatgpt.com/cb",
        "--print-once",
      ],
      {
        LLM_GATEWAY_CONFIG: cfg,
      }
    );
    const list = run(["oauth", "client", "list"], { LLM_GATEWAY_CONFIG: cfg });
    expect(list.status).toBe(0);
    expect(list.stdout).not.toContain("scrypt:");
    expect(list.stdout).not.toMatch(/"client_secret"/);
    const parsed = JSON.parse(list.stdout);
    expect(parsed.clients[0].secret_configured).toBe(true);
  });

  it("connector setup emits a copy-safe JSON packet on stdout and omits legacy no-auth by default", () => {
    const cfg = freshConfig();
    const result = run(["connector", "setup"], {
      LLM_GATEWAY_CONFIG: cfg,
      LLM_GATEWAY_PUBLIC_URL: "https://gw.example.trycloudflare.com",
      LLM_GATEWAY_TUNNEL_PROVIDER: "gw.example.trycloudflare.com",
      LLM_GATEWAY_NO_AUTH_PATHS: "/chatgpt/secretpath/mcp",
    });
    expect(result.status).toBe(0);
    const packet = JSON.parse(result.stdout);
    expect(packet.schema).toBe("remote-connector-setup.v1");
    expect(result.stdout).not.toContain("legacy_no_auth");
    expect(result.stdout).not.toContain("secretpath");

    const withLegacy = run(["connector", "setup", "--include-legacy-no-auth"], {
      LLM_GATEWAY_CONFIG: cfg,
      LLM_GATEWAY_PUBLIC_URL: "https://gw.example.trycloudflare.com",
      LLM_GATEWAY_TUNNEL_PROVIDER: "gw.example.trycloudflare.com",
      LLM_GATEWAY_NO_AUTH_PATHS: "/chatgpt/secretpath/mcp",
    });
    const legacyPacket = JSON.parse(withLegacy.stdout);
    expect(legacyPacket.legacy_no_auth.deprecated).toBe(true);
    expect(legacyPacket.legacy_no_auth.connector_url).toContain("/chatgpt/secretpath/mcp");
  });
});
