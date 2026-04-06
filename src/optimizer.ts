type OptimizationMode = "prompt" | "response";

const COURTESY_PATTERNS: RegExp[] = [
  /\bPlease\b[:,]?\s*/gi,
  /\bCould you\b\s*/gi,
  /\bI would like you to\b\s*/gi,
  /\bI would like\b\s*/gi,
  /\bI need you to\b\s*/gi,
  /\bI just implemented\b\s*/gi,
  /\bPlease do the following:?\s*/gi,
];

const ADJECTIVE_PATTERNS: RegExp[] = [
  /\bcomprehensive\b/gi,
  /\bdetailed\b/gi,
  /\bthorough\b/gi,
  /\boverall\b/gi,
  /\bcritical\b/gi,
];

const TASK_PREFIXES: RegExp[] = [
  /^(First|Then|After that|Finally),?\s*/i,
  /^(First|Then|After that|Finally),?\s*you should\s*/i,
];

export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const words = trimmed.split(/\s+/).length;
  return Math.ceil(words * 1.3);
}

export function optimizePrompt(text: string): string {
  return optimizeText(text, "prompt");
}

export function optimizeResponse(text: string): string {
  return optimizeText(text, "response");
}

function optimizeText(text: string, mode: OptimizationMode): string {
  if (!text.trim()) return text;
  const parts: string[] = [];
  const codeBlockRegex = /```[\s\S]*?```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    parts.push(optimizeSegment(text.slice(lastIndex, match.index), mode));
    parts.push(match[0]);
    lastIndex = match.index + match[0].length;
  }
  parts.push(optimizeSegment(text.slice(lastIndex), mode));
  return parts.join("");
}

function optimizeSegment(segment: string, mode: OptimizationMode): string {
  const inlineParts = segment.split(/(`[^`]*`)/g);
  return inlineParts
    .map(part => (part.startsWith("`") ? part : optimizePlain(part, mode)))
    .join("");
}

function optimizePlain(text: string, mode: OptimizationMode): string {
  let output = text;

  COURTESY_PATTERNS.forEach(pattern => {
    output = output.replace(pattern, "");
  });

  ADJECTIVE_PATTERNS.forEach(pattern => {
    output = output.replace(pattern, "");
  });

  output = output.replace(/\bfound in the [^:.\n]+/gi, "");
  output = output.replace(/\bthat we implemented\b/gi, "");
  output = output.replace(/\bwe implemented\b/gi, "");
  output = output.replace(/\bthe\s+([a-z][\w\s-]+?)\s+system\b/gi, "$1");
  output = output.replace(/\bthe\s+([a-z][\w\s-]+?)\s+feature\b/gi, "$1");

  output = output.replace(/^\s*Problem:\s*/gim, "");
  output = inlineFileReferences(output);
  output = compactTypes(output);
  output = output.replace(/\bAre there any\s+([^?]+)\?/gi, "$1?");

  output = compressTaskLists(output);
  output = applyArrowNotation(output);
  output = applySlashNotation(output);

  if (mode === "response") {
    output = output.replace(/\bIn conclusion\b[:,]?\s*/gi, "");
    output = output.replace(/\bOverall\b[:,]?\s*/gi, "");
  }

  output = output.replace(/[ \t]+/g, " ");
  output = output.replace(/\n{3,}/g, "\n\n");
  return output.trimEnd();
}

function inlineFileReferences(text: string): string {
  const replaceLines = (lines: string) => {
    const matches = lines.match(/\d+/g);
    if (!matches) return lines.trim();
    return matches.join(",");
  };

  let output = text.replace(
    /\b(?:in (?:the )?file\s+)?(\S+)\s+(?:on|at)\s+lines?\s+([0-9 ,and~]+)/gi,
    (_match, file, lines) => `${file}:${replaceLines(lines)}`
  );

  output = output.replace(
    /\b(?:in (?:the )?file\s+)?(\S+)\s+on line\s+~?(\d+)/gi,
    (_match, file, line) => `${file}:${line}`
  );

  output = output.replace(/\b(\S+)\s+line\s+~?(\d+)/gi, (_match, file, line) => `${file}:${line}`);

  output = output.replace(
    /\b(?:in the )?([\w./-]+)\s+file\s+at\s+lines?\s+([0-9 ,and~]+)/gi,
    (_match, file, lines) => `${file}:${replaceLines(lines)}`
  );

  output = output.replace(/\bin the\s+([\w./-]+)\s+file:(\d+(?:,\d+)*)/gi, "$1:$2");

  return output;
}

function compactTypes(text: string): string {
  let output = text;
  output = output.replace(/\ban? optional boolean\s*\(default\s*(true|false)\)/gi, "bool=$1");
  output = output.replace(/\boptional boolean\b/gi, "bool?");
  output = output.replace(/\bboolean\b/gi, "bool");
  output = output.replace(/\ban? required integer\b/gi, "int!");
  output = output.replace(/\ban? integer\b/gi, "int");
  output = output.replace(/\ban? array of strings\b/gi, "str[]");
  output = output.replace(/\bstring enum of\s*(\[[^\]]+\])/gi, "enum$1");
  output = output.replace(/\bstring enum\b/gi, "enum");
  output = output.replace(/\bstring parameter\b/gi, "param:str");
  output = output.replace(/\bstring\b/gi, "str");
  return output;
}

function compressTaskLists(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      let j = i;
      while (j < lines.length && /^\s*\d+\.\s+/.test(lines[j])) {
        const item = lines[j].replace(/^\s*\d+\.\s+/, "");
        items.push(cleanTaskItem(item));
        j += 1;
      }
      if (items.length > 1) {
        output.push(`Tasks: ${items.join(" → ")}`);
        i = j - 1;
        continue;
      }
    }

    if (/^\s*-\s+/.test(line)) {
      const items: string[] = [];
      let j = i;
      while (j < lines.length && /^\s*-\s+/.test(lines[j])) {
        const item = lines[j].replace(/^\s*-\s+/, "");
        items.push(cleanTaskItem(item));
        j += 1;
      }
      if (items.length > 1) {
        output.push(items.join(" → "));
        i = j - 1;
        continue;
      }
    }

    output.push(line);
  }

  return output.join("\n");
}

function cleanTaskItem(item: string): string {
  let cleaned = item.trim();
  TASK_PREFIXES.forEach(pattern => {
    cleaned = cleaned.replace(pattern, "");
  });
  cleaned = cleaned.replace(/^you should\s*/i, "");
  cleaned = cleaned.replace(/^\bPlease\b\s*/i, "");
  cleaned = cleaned.replace(/[.:;]+$/g, "");
  return cleaned;
}

function applyArrowNotation(text: string): string {
  const lines = text.split("\n");
  const output = lines.map(line => {
    let updated = line;
    updated = updated.replace(
      /\bChange\s+(?:the\s+)?([A-Za-z][\w-]*)\s+to\s+(?:a\s+|an\s+)?([A-Za-z][\w-]*)([.!?]|$)/gi,
      (_m, from, to, end) => {
        return `${from.trim()} → ${to.trim()}${end || ""}`;
      }
    );
    updated = updated.replace(
      /\bConvert\s+(?:the\s+)?([A-Za-z][\w-]*)\s+to\s+(?:a\s+|an\s+)?([A-Za-z][\w-]*)([.!?]|$)/gi,
      (_m, from, to, end) => {
        return `${from.trim()} → ${to.trim()}${end || ""}`;
      }
    );
    updated = updated.replace(/\b(\w+)\s+should be\s+an?\s+(\w+)/gi, "$1: $2");
    return updated;
  });
  return output.join("\n");
}

function applySlashNotation(text: string): string {
  const lines = text.split("\n");
  const output = lines.map(line => {
    const trimmed = line.trim();
    if (trimmed.length < 50 && /^[A-Za-z0-9][A-Za-z0-9\s/&-]+$/.test(trimmed)) {
      return line.replace(/\s+and\s+/, "/");
    }
    return line;
  });
  return output.join("\n");
}
