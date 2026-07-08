# Native Compressor PR-1: verification evidence

Skill: verify (spec Section 9 item 14). Two harnesses drive the real exported
wiring against real provider output and the real registered async tool. Build:
`feat/native-compressor-pr1` @ 1cd09b5, dist rebuilt.

## Sync path: buildCliResponse against real Codex output

Captured a live `codex_request` reply of 16 identical `RETRY connection
refused` lines (correlationId 92951739-a110-4e3b-8980-0c7e87b455bb), fed the
raw `--json` event stream through the exported `buildCliResponse` with the
effective compression flag off then on, logged completion + telemetry to a
real `FlightRecorder`, and read the rows back.

- Flag OFF: returned text 399 chars, byte-identical to the reconstructed
  reply, `content[0].text === structuredContent.response`, no `[[gateway-`
  sentinel, no `compression` field, no telemetry row (compression_route NULL).
- Flag ON: returned text 382 chars, route `log`, transforms
  `[dedup, leading-note]`, both response surfaces mirror the same compressed
  string, leading note present.
- Flight recorder (escape hatch): the stored `response` for BOTH runs is the
  raw 16 lines (399 chars, pre-compression), proving `llm_request_result`
  returns uncompressed text. Compression telemetry on the ON row:
  compression_route=log, original->compressed 399->382, est tokens saved 5.

Measured savings note: 16 short identical lines fold to 1 line plus the ~200
char leading note, so net savings are modest (4%) on this small fixture; the
note is fixed overhead that pays off on larger repetitive outputs (the unit
fixtures with 40 reps compress far more). The compressor returns identity
rather than inflating when savings would not beat the marker overhead.

## Async path: real llm_job_result tool with a seeded MemoryJobStore

Seeded two completed Claude `stream-json` jobs (NDJSON stdout, a 20-line
repetitive assistant reply) with `compress_response` false and true, then
invoked the REAL registered `llm_job_result` tool handler.

- Flag OFF: envelope pretty-printed (indented), `result.stdout` is the raw
  NDJSON event stream, `parsed.text` present. Byte-identical to pre-change.
- Flag ON: envelope compact (no indentation), `result.stdout` is the
  compressed prose (starts with the leading note, raw NDJSON gone via the
  codex-precedent display swap), `parsed.text` omitted so the compressed reply
  is not duplicated, `parsed.usage` retained. result.stdout 386 vs raw reply
  579 chars.

Both harnesses exit 0 (all assertions held). This confirms, on real data: the
single compressDisplayText call site, the dual-surface mirror, the flag gate,
the write-once telemetry, the pre-compression escape hatch, the Claude
stream-json async swap (round-1 blocker R1-2), and the compact envelope
(spec 5.4).
