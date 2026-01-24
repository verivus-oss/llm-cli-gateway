import { executeCli } from "../utils/executor.js";

export interface CodexOptions {
  model?: string;
  fullAuto?: boolean;
}

export async function executeCodexRequest(
  prompt: string,
  options: CodexOptions = {}
): Promise<string> {
  const args = ["exec"];

  if (options.model) {
    args.push("--model", options.model);
  }

  if (options.fullAuto) {
    args.push("--full-auto");
  }

  args.push("--skip-git-repo-check");
  args.push(prompt);

  const { stdout, stderr, code } = await executeCli("codex", args);

  if (code !== 0) {
    throw new Error(`Codex failed with code ${code}: ${stderr}`);
  }

  return stdout;
}
