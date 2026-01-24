import { describe, expect, it } from "vitest";
import { estimateTokens, optimizePrompt, optimizeResponse } from "../optimizer.js";

describe("optimizer", () => {
  it("applies prompt optimization patterns", () => {
    const verbose = `
Please implement the following feature:
I would like you to help me with the session management system.
Fix the 3 critical bugs found in the product review:
Change foo to bar.
Convert the string to a number.
The result should be an array.
in the file src/index.ts on line 430
in the session-manager.ts file at lines 57 and 133
Parameter: an optional boolean (default false), a required integer, an array of strings, a string parameter.
Architecture and design
Please do the following:
1. First, you should read the files
2. Then, make the changes
3. After that, run the tests
4. Finally, show the diff
Could you check: Are there any bugs?
`;

    const optimized = optimizePrompt(verbose);

    expect(optimized).not.toMatch(/Please|Could you|I would like/i);
    expect(optimized).toContain("src/index.ts:430");
    expect(optimized).toContain("session-manager.ts:57,133");
    expect(optimized).toContain("foo → bar");
    expect(optimized).toContain("str → number");
    expect(optimized).toContain("result: array");
    expect(optimized).toContain("bool=false");
    expect(optimized).toContain("int!");
    expect(optimized).toContain("str[]");
    expect(optimized).toContain("param:str");
    expect(optimized).toContain("Architecture/design");
    expect(optimized).toContain("Tasks:");
    expect(optimized).toMatch(/read/i);
    expect(optimized).toContain("→");
    expect(optimized).toMatch(/bugs\?/i);
    expect(optimized).not.toMatch(/management system/i);
  });

  it("preserves code blocks", () => {
    const input = `
Please change the following:

\`\`\`ts
const filePath = "src/index.ts";
const value: string = "string";
\`\`\`

Change string to number.
`;

    const optimized = optimizePrompt(input);

    expect(optimized).toContain(`\`\`\`ts
const filePath = "src/index.ts";
const value: string = "string";
\`\`\``);
    expect(optimized).toContain("str → number");
  });

  it("optimizes responses and keeps code blocks intact", () => {
    const input = `
In conclusion, the output is below:

\`\`\`json
{"result": "ok", "value": "string"}
\`\`\`

Overall, there are no issues.
`;

    const optimized = optimizeResponse(input);

    expect(optimized).toContain(`\`\`\`json
{"result": "ok", "value": "string"}
\`\`\``);
    expect(optimized).not.toMatch(/In conclusion|Overall/i);
  });

  it("achieves 35-50% token reduction on verbose prompts", () => {
    const verbose = `
Please implement the following feature for session management in the llm-cli-gateway.
I would like you to help me create comprehensive documentation for the new prompt optimization feature.
The documentation should include:
1. First, you should read the files
2. Then, make the changes
3. After that, run the tests
4. Finally, show the diff
In the file src/index.ts on line 430 change the string to a number.
In the session-manager.ts file at lines 57 and 133 change foo to bar.
Could you check: Are there any bugs?
`;

    const optimized = optimizePrompt(verbose);
    const beforeTokens = estimateTokens(verbose);
    const afterTokens = estimateTokens(optimized);
    const reduction = (beforeTokens - afterTokens) / beforeTokens;

    expect(reduction).toBeGreaterThanOrEqual(0.35);
    expect(reduction).toBeLessThanOrEqual(0.5);
  });
});
