// κ live smoke test: does Anthropic honor cache_control passed via
// Claude Code's --input-format stream-json?
//
// Sends two identical stream-json user messages, each containing a
// substantial stable text block marked with `cache_control:
// {type: "ephemeral"}`, followed by a short variable task.
//
// PASS criterion: between call 1 and call 2 (run within Anthropic's
// cache TTL), call 2's `cache_read_input_tokens` should be HIGHER than
// call 1's by approximately the size of the marked block — proving the
// explicit cache_control breakpoint took effect (vs Claude Code's
// implicit session-bound wrapping that re-creates every call).
//
// Run: node /tmp/kappa-smoke.mjs

import { spawn } from "node:child_process";

// ~2K-token stable block. Must exceed Sonnet's 1024-token cache
// minimum AND Claude Code's per-account 1h-TTL convention (see below).
// Duplicated paragraphs to push token count comfortably above 1024.
const STABLE_BLOCK = (`
=== KAPPA SMOKE TEST STABLE REFERENCE ===

This block is intentionally cacheable. It is sent identically on every
call, marked with cache_control: { type: "ephemeral" }. If Anthropic
honors the breakpoint, the second call should show
cache_read_input_tokens roughly equal to this block's token count plus
Claude Code's account-baseline cache.

Architectural notes (filler content to push the block past the 1024-token
cacheable minimum for Sonnet):

The llm-cli-gateway exposes five upstream CLIs via a single MCP server:
Claude Code, OpenAI Codex, Google Gemini, xAI Grok, and Mistral Vibe.
Each request flows through prepare*Request → executor.spawn → CLI
process → parse*JsonStream → flight recorder. Session state is minimal
(id, cli, timestamps, optional description) and never includes
conversation content. Retry logic uses per-CLI circuit breakers with a
5-failure threshold and 60-second reset window. The flight recorder
writes a two-phase logStart/logComplete pair per request and stores
tokens, costs, durations, and a content-addressed stable_prefix_hash.

Cache observability comes from per-CLI parsers: claude --output-format
stream-json yields SDKAssistantMessage and SDKResultMessage events with
cache_read_input_tokens and cache_creation_input_tokens; codex --json
yields turn.completed events with cached_input_tokens (current CLI
field, preferred over the legacy cache_read_input_tokens fallback);
gemini -o stream-json yields NDJSON with type:init, type:message, and
type:result events. Grok and Mistral Vibe do not surface cache stats
through their CLIs.

Implicit cache discipline in the gateway means assembling
system → tools → context → task as a single positional prompt so the
stable prefix bytes precede the volatile task tail unchanged across
calls. Explicit cache_control via --input-format stream-json
(this slice, kappa) gives the caller direct control over where
breakpoints land, decoupling cache reuse from session-id wrapping.

Anthropic per-model minimum cacheable tokens: Sonnet 4.6 / 4.5 / 4 /
3.5 = 1024 tokens; Opus 4.5+ = 4096; Haiku 4.5 = 4096; Haiku 3.5
(Vertex) = 2048. Prompts shorter than the minimum are not cached even
if cache_control is set, and no error is returned.

Filler paragraphs to ensure this block clears 1024 tokens by a wide
margin so cache misses cannot be blamed on the minimum-cacheable
threshold. The lazy dog jumped over the quick brown fox. The quick
brown fox jumped over the lazy dog. Lorem ipsum dolor sit amet,
consectetur adipiscing elit, sed do eiusmod tempor incididunt ut
labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud
exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.
Duis aute irure dolor in reprehenderit in voluptate velit esse cillum
dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non
proident, sunt in culpa qui officia deserunt mollit anim id est
laborum. Sed ut perspiciatis unde omnis iste natus error sit voluptatem
accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae
ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt
explicabo. Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut
odit aut fugit, sed quia consequuntur magni dolores eos qui ratione
voluptatem sequi nesciunt. Neque porro quisquam est, qui dolorem ipsum
quia dolor sit amet, consectetur, adipisci velit, sed quia non numquam
eius modi tempora incidunt ut labore et dolore magnam aliquam quaerat
voluptatem.

=== END KAPPA SMOKE TEST STABLE REFERENCE ===
`).repeat(3).trim();

const buildPayload = (taskTag) =>
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: STABLE_BLOCK,
          // Claude Code injects ~6 system content blocks before user
          // content, and marks them with ttl='1h'. Anthropic rejects a
          // 1h block that appears AFTER a 5m block (ordering rule), so
          // user-injected cache_control must be 1h too.
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
        {
          type: "text",
          text: `Reply with exactly: ${taskTag}`,
        },
      ],
    },
  });

function runCall(taskTag) {
  return new Promise((resolve, reject) => {
    const payload = buildPayload(taskTag);
    const proc = spawn(
      "claude",
      [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        "sonnet",
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(
          new Error(`claude exited ${code}; stderr=${stderr.slice(0, 500)}`)
        );
      }
      // Find the terminal `result` event for usage.
      const lines = stdout.split("\n").filter((l) => l.trim());
      let result = null;
      let assistantText = null;
      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          if (ev.type === "result") result = ev;
          if (ev.type === "assistant" && ev.message?.content?.[0]?.text) {
            assistantText = ev.message.content[0].text;
          }
        } catch {}
      }
      if (!result) {
        return reject(
          new Error(`No 'result' event in claude output; tail: ${stdout.slice(-500)}`)
        );
      }
      resolve({
        taskTag,
        durationMs: result.duration_ms,
        replyText: assistantText ?? result.result,
        usage: {
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
          cache_read_input_tokens: result.usage.cache_read_input_tokens,
          cache_creation_input_tokens: result.usage.cache_creation_input_tokens,
          ephemeral_5m: result.usage.cache_creation?.ephemeral_5m_input_tokens,
          ephemeral_1h: result.usage.cache_creation?.ephemeral_1h_input_tokens,
        },
        cost_usd: result.total_cost_usd,
        stable_block_chars: STABLE_BLOCK.length,
      });
    });

    proc.stdin.write(payload + "\n");
    proc.stdin.end();
  });
}

(async () => {
  console.log("STABLE_BLOCK characters:", STABLE_BLOCK.length);
  console.log("Approx stable-block tokens:", Math.round(STABLE_BLOCK.length / 4));
  console.log();

  console.log("Call 1 (cache should be WRITTEN for the marked block)...");
  const r1 = await runCall("KAPPA-SMOKE-1");
  console.log(JSON.stringify(r1, null, 2));
  console.log();

  // 5-second gap, well inside Anthropic's 5-min default cache TTL.
  await new Promise((res) => setTimeout(res, 5000));

  console.log("Call 2 (cache should be READ for the marked block)...");
  const r2 = await runCall("KAPPA-SMOKE-2");
  console.log(JSON.stringify(r2, null, 2));
  console.log();

  // Verdict
  const delta_creation =
    r1.usage.cache_creation_input_tokens - r2.usage.cache_creation_input_tokens;
  const delta_read =
    r2.usage.cache_read_input_tokens - r1.usage.cache_read_input_tokens;

  console.log("=== VERDICT ===");
  console.log("Cache CREATION drop (call 1 → call 2):", delta_creation, "tokens");
  console.log("Cache READ rise (call 1 → call 2):", delta_read, "tokens");
  console.log();

  if (delta_read > 500 && delta_creation > 500) {
    console.log(
      "PASS: explicit cache_control via stream-json IS honored by Anthropic."
    );
    console.log(
      "      The marked block shifted from cache_creation on call 1 to cache_read on call 2."
    );
    console.log("      κ Branch A is implementable as designed.");
  } else if (Math.abs(delta_read) < 200 && Math.abs(delta_creation) < 200) {
    console.log(
      "FAIL: no cache shift between calls. Either cache_control was dropped"
    );
    console.log(
      "      by Claude Code's input handler, or the block stayed under the"
    );
    console.log("      Sonnet 1024-token cache minimum. Investigate."
    );
  } else {
    console.log(
      "AMBIGUOUS: partial shift. Possible Claude Code re-wraps the block with"
    );
    console.log(
      "           per-session content that changes the cache key. Investigate"
    );
    console.log("           with a smaller / larger stable block.");
  }
})();
