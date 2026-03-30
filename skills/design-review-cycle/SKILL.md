---
name: design-review-cycle
description: Structured design document review via LLM gateway — submit plans, specs, or designs for peer review from Codex/Gemini, iterate on feedback, track review rounds. Use before implementing complex features.
---

# Design Review Cycle

Submit design documents, implementation plans, or specifications for peer review through the LLM gateway. Track review iterations until approval.

## When to Use

- Before implementing a complex feature (review the plan first)
- After writing a specification or design document
- When a development process requires peer review before code
- For architecture decisions that affect multiple components

## Review Workflow

### Step 1: Prepare the Review Request

Write a clear review request that includes:
- What document to review (file path)
- What kind of review (design, spec, plan, architecture)
- Specific concerns or focus areas
- Iteration number (for tracking)

### Step 2: Submit to Reviewer(s)

**Single reviewer (Codex — most common):**

```
codex_request({
  prompt: "Review the design document at [path]. This is a [spec/plan/design] for [feature].\n\nReview for:\n- Completeness (are all requirements addressed?)\n- Correctness (will this approach work?)\n- Feasibility (can this be implemented as described?)\n- Risks (what could go wrong?)\n- Missing considerations\n\nGive APPROVED or NOT APPROVED with specific, actionable findings.",
  fullAuto: true,
  correlationId: "design-review-r1"
})
```

**Dual reviewer (Codex + Gemini for security-sensitive designs):**

```
codex_request_async({
  prompt: "Review the design document at [path]...",
  fullAuto: true,
  correlationId: "design-review-r1-codex"
})
gemini_request_async({
  prompt: "Review the design document at [path]. Focus on security implications, attack surfaces, data flow risks, and failure modes...",
  model: "gemini-2.5-pro",
  correlationId: "design-review-r1-gemini"
})
```

### Step 3: Process Feedback

Parse the review response for:
1. **APPROVED** → Proceed to implementation
2. **NOT APPROVED** with findings → Address each finding
3. **Conditional approval** ("approved if X is addressed") → Address X, re-submit

For each finding:
- Update the design document to address it
- Or explicitly document why the finding doesn't apply (with justification)

### Step 4: Re-submit

```
codex_request({
  prompt: "Re-review the design at [path] after addressing round 1 feedback:\n\n1. [Finding] — Addressed by: [what changed]\n2. [Finding] — Addressed by: [what changed]\n3. [Finding] — Not applicable because: [justification]\n\nReview the updated document. APPROVED or NOT APPROVED.",
  fullAuto: true,
  correlationId: "design-review-r2"
})
```

### Step 5: Track Iterations

Use correlation IDs to track rounds:
- `design-review-r1` → Initial review
- `design-review-r2` → After first round of fixes
- `design-review-r3` → After second round (rare)

If after 3 rounds the design is still not approved, the design likely needs a fundamental rethink — escalate to the user.

## Document Types and Review Focus

| Document Type | Primary Reviewer | Focus Areas |
|--------------|-----------------|-------------|
| Implementation plan | Codex | Feasibility, task ordering, test strategy |
| API specification | Codex + Gemini | Completeness, security, error handling |
| Architecture decision | Codex | Trade-offs, scalability, maintenance burden |
| Security design | Gemini | Attack surfaces, threat model, mitigations |
| Data model | Codex | Normalization, query patterns, migration path |

## Review Request Templates

### For Implementation Plans

```
Review the implementation plan at [path].

Context: This plan implements [feature] for [project].

Check:
- Are tasks ordered correctly (dependencies respected)?
- Is the test strategy adequate?
- Are there missing tasks or gaps?
- Is the scope appropriate (not too broad, not too narrow)?
- Are file paths and function names consistent throughout?

APPROVED or NOT APPROVED with findings.
```

### For API Specifications

```
Review the API specification at [path].

Context: This API serves [purpose] for [consumers].

Check:
- Are all endpoints documented with request/response schemas?
- Are error cases handled (400, 401, 403, 404, 500)?
- Is authentication/authorization specified?
- Are there rate limiting or pagination considerations?
- Is the naming consistent and RESTful?

APPROVED or NOT APPROVED with findings.
```

### For Architecture Decisions

```
Review the architecture decision at [path].

Context: This decision affects [components] in [project].

Check:
- Are alternatives considered and trade-offs documented?
- Is the chosen approach justified with concrete reasons?
- What are the long-term maintenance implications?
- Are there migration or rollback considerations?
- Does this align with existing system architecture?

APPROVED or NOT APPROVED with findings.
```

## Integration with sqry Review Process

Many sqry review documents follow this naming convention:
- `01_SPEC.md` → Specification
- `02_DESIGN.md` → Design document
- `02_DESIGN_review_r1_request.md` → Review request (round 1)
- `02_DESIGN_review_r2_request.md` → Review request (round 2)

The skill works with any document structure — the naming convention is optional.

## Tips

- Always provide file paths, not inline content. Let the reviewer read the document.
- Include context about the project and feature — reviewers don't have your conversation history.
- Use `correlationId` for every review round to enable tracing.
- For large documents, tell the reviewer which sections changed between rounds.
- If Codex can't read files (sandbox), paste the relevant sections inline.
- Design reviews are cheaper than code reviews — catch issues before writing code.
