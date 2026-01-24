import { executeCli } from "../utils/executor.js";

export interface GeminiOptions {
  model?: string;
}

export async function executeGeminiRequest(
  prompt: string,
  options: GeminiOptions = {}
): Promise<string> {
  const args = [prompt];

  if (options.model) {
    args.push("--model", options.model);
  }

  const { stdout, stderr, code } = await executeCli("gemini", args);

  if (code !== 0) {
    throw new Error(`Gemini failed with code ${code}: ${stderr}`);
  }

  return stdout;
}
