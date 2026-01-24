import { executeCli } from "../utils/executor.js";

export interface ClaudeOptions {
  model?: string;
  outputFormat?: string;
}

export async function executeClaudeRequest(
  prompt: string,
  options: ClaudeOptions = {}
): Promise<string> {
  const args = ["-p", prompt];

  if (options.model) {
    args.push("--model", options.model);
  }

  if (options.outputFormat === "json") {
    args.push("--output-format", "json");
  }

  const { stdout, stderr, code } = await executeCli("claude", args);

  if (code !== 0) {
    throw new Error(`Claude failed with code ${code}: ${stderr}`);
  }

  return stdout;
}
