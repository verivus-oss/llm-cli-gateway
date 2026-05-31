# Round 2 Evidence Addendum — One-Line Lint Fix

**Date**: 2026-05-31  
**Context**: Claude (in Round 1) surfaced a single concrete blocker: a new `prefer-const` ESLint error at `src/upstream-contracts.ts:1110` inside the newly added `extractDiscoveredFlags` function (`let name` that is never reassigned). This caused `npx eslint ...` (part of `npm run lint` / `npm run check`) to fail.

**Fix applied** (one character change):
```diff
-    let name = `--${match[1].toLowerCase().replace(/_/g, "-")}`;
+    const name = `--${match[1].toLowerCase().replace(/_/g, "-")}`;
```

**Verification performed immediately after the edit**:
- `npx eslint src/upstream-contracts.ts --rule 'prefer-const: error' --format compact` → No violations reported on or near line 1110.
- `npm run upstream:contracts` → Still "contracts-check OK: 5 providers... (offline)".
- `npx vitest run src/__tests__/upstream-contracts.test.ts` → 12/12 passed.

**Scope for Round 2**: Reviewers are asked to re-inspect **only** this one-line delta (plus re-confirm the surrounding function and that the overall change still satisfies the Verification Report). No other files were modified between Round 1 and Round 2.

The minimal additional diff for this fix:
```diff
diff --git a/src/upstream-contracts.ts b/src/upstream-contracts.ts
index ... 
--- a/src/upstream-contracts.ts
+++ b/src/upstream-contracts.ts
@@ -1107,7 +1107,7 @@ export function extractDiscoveredFlags(helpText: string): readonly string[] {
   let match: RegExpExecArray | null;
   while ((match = longRe.exec(helpText)) !== null) {
-    let name = `--${match[1].toLowerCase().replace(/_/g, "-")}`;
+    const name = `--${match[1].toLowerCase().replace(/_/g, "-")}`;
     if (name.length >= 3 && !name.includes("://") && !name.includes("--help")) {
       discovered.add(name);
     }
```

This change is purely stylistic / lint-clean and does not alter runtime behavior.
