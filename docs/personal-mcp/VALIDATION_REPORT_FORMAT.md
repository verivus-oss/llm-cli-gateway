# Validation Report Format

Status: Layer 5 report format

Validation tools return a compact human-readable report plus structured content for clients that can inspect JSON.

## Top-Level Shape

```json
{
  "schemaVersion": "validation-report.v1",
  "humanReadable": "Validation report ...",
  "structuredContent": {
    "validationId": "...",
    "status": "running",
    "startedAt": "2026-05-19T00:00:00.000Z",
    "intent": "validate",
    "originalRequest": {
      "question": "...",
      "content": "...",
      "focus": "..."
    },
    "modelList": ["claude", "codex"],
    "perModelOutputs": [],
    "disagreements": {
      "hasMaterialDisagreement": true,
      "summary": "...",
      "signals": []
    },
    "finalRecommendation": "...",
    "confidence": "low",
    "limitations": [],
    "jobIds": [],
    "synthesis": {
      "status": "waiting_for_provider_results",
      "judgeModel": null,
      "rawJobReference": null,
      "note": "..."
    }
  }
}
```

## Fields

- `humanReadable`: compact text for normal chat clients.
- `structuredContent.originalRequest`: the user request being validated.
- `structuredContent.modelList`: providers asked to participate.
- `structuredContent.perModelOutputs`: normalized provider status, verdict, rationale, risks, warnings, errors, and job references.
- `structuredContent.disagreements`: conservative disagreement summary. Pending, failed, skipped, canceled, or orphaned providers prevent a consensus claim.
- `structuredContent.finalRecommendation`: next action for the user.
- `structuredContent.confidence`: `none`, `low`, `medium`, or `high`.
- `structuredContent.limitations`: operational caveats, including pending jobs and omitted non-completed judge evidence.
- `structuredContent.jobIds`: job IDs to poll with `job_status` and `job_result`.
- `structuredContent.synthesis`: optional explicit judge job status and reference.

## Consensus Rule

The report must not claim consensus when:

- completed provider verdicts differ;
- any provider is still running;
- any provider failed, was skipped, was canceled, or is orphaned;
- judge synthesis has not run and the caller asked for it.

Large raw model outputs stay behind `job_result` references so the initiating MCP client receives a concise report.
