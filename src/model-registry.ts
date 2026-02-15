import { Dirent, existsSync, readFileSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import path from "path";
import type { CliType } from "./session-manager.js";

export interface CliInfo {
  description: string;
  models: Record<string, string>;
  defaultModel?: string;
  modelOrder?: string[];
}

export type CliInfoMap = Record<CliType, CliInfo>;

const FALLBACK_INFO: CliInfoMap = {
  claude: {
    description: "Anthropic's Claude Code CLI - best for code generation, analysis, and agentic coding tasks",
    models: {
      opus: "Most capable model. Best for: complex reasoning, nuanced analysis, difficult problems, research",
      sonnet: "Balanced performance. Best for: everyday coding, code review, general tasks (default)",
      haiku: "Fastest model. Best for: simple queries, quick answers, high-volume tasks, cost-sensitive use"
    },
    defaultModel: "sonnet",
    modelOrder: ["opus", "sonnet", "haiku"]
  },
  codex: {
    description: "OpenAI's Codex CLI - best for code execution in sandboxed environments",
    models: {
      "o3": "Most capable reasoning model. Best for: complex multi-step problems, math, science",
      "o4-mini": "Fast reasoning model. Best for: coding tasks, quick iterations",
      "gpt-4.1": "Latest GPT-4 variant. Best for: general coding, instruction following"
    }
  },
  gemini: {
    description: "Google's Gemini CLI - best for multimodal tasks and Google ecosystem integration",
    models: {
      "gemini-2.5-pro": "Most capable model. Best for: complex reasoning, long context, multimodal",
      "gemini-2.5-flash": "Fast model. Best for: quick responses, high throughput, cost-sensitive use"
    }
  }
};

const MODEL_CACHE_TTL_MS = 2 * 60 * 1000;
let cachedInfo: { loadedAt: number; info: CliInfoMap } | null = null;

export function getCliInfo(forceRefresh = false): CliInfoMap {
  if (!forceRefresh && cachedInfo && Date.now() - cachedInfo.loadedAt < MODEL_CACHE_TTL_MS) {
    return cachedInfo.info;
  }

  const info = buildCliInfo();
  cachedInfo = { loadedAt: Date.now(), info };
  return info;
}

export function resolveModelAlias(cli: CliType, model: string | undefined, info: CliInfoMap): string | undefined {
  if (!model) {
    return undefined;
  }

  const trimmed = model.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = trimmed.toLowerCase();
  const cliInfo = info[cli];

  if (normalized === "default" || normalized === "latest") {
    return cliInfo.defaultModel ?? trimmed;
  }

  if (cli === "gemini") {
    if (normalized === "flash" || normalized === "pro") {
      const picked = pickLatestMatching(cliInfo, normalized);
      return picked ?? trimmed;
    }
  }

  return trimmed;
}

function buildCliInfo(): CliInfoMap {
  const info: CliInfoMap = {
    claude: cloneInfo(FALLBACK_INFO.claude),
    codex: cloneInfo(FALLBACK_INFO.codex),
    gemini: cloneInfo(FALLBACK_INFO.gemini)
  };

  applyClaudeOverrides(info.claude);
  applyCodexOverrides(info.codex);
  applyGeminiOverrides(info.gemini);

  return info;
}

function cloneInfo(source: CliInfo): CliInfo {
  return {
    description: source.description,
    models: { ...source.models },
    defaultModel: source.defaultModel,
    modelOrder: source.modelOrder ? [...source.modelOrder] : undefined
  };
}

function applyClaudeOverrides(info: CliInfo): void {
  const settingsPath = path.join(homedir(), ".claude", "settings.json");
  const settingsLocalPath = path.join(homedir(), ".claude", "settings.local.json");
  const envDefault = process.env.CLAUDE_DEFAULT_MODEL;
  const localDefault = readJsonValue(settingsLocalPath, "model");
  const settingsDefault = readJsonValue(settingsPath, "model");
  const defaultModel = envDefault || localDefault || settingsDefault;
  const defaultSource = envDefault
    ? "CLAUDE_DEFAULT_MODEL"
    : localDefault
      ? settingsLocalPath
      : settingsPath;

  if (defaultModel && typeof defaultModel === "string") {
    if (!info.models[defaultModel]) {
      info.models[defaultModel] = `Configured default from ${defaultSource}`;
    }
    info.defaultModel = defaultModel;
  }

  const envModels = parseEnvModels(process.env.CLAUDE_MODELS);
  if (envModels.length > 0) {
    envModels.forEach(model => {
      if (!info.models[model]) {
        info.models[model] = "Configured via CLAUDE_MODELS";
      }
    });
  }

  info.modelOrder = buildOrder(info, info.defaultModel);
}

function applyCodexOverrides(info: CliInfo): void {
  const configPath = process.env.CODEX_CONFIG_PATH || path.join(homedir(), ".codex", "config.toml");
  const envDefault = process.env.CODEX_DEFAULT_MODEL;
  const envModels = parseEnvModels(process.env.CODEX_MODELS);

  const detectedModels: Record<string, string> = {};
  let defaultModel: string | undefined;

  if (existsSync(configPath)) {
    const content = readFileSync(configPath, "utf-8");
    const model = extractTomlString(content, "model");
    if (model) {
      detectedModels[model] = `Default from ${configPath}`;
      defaultModel = model;
    }

    const migrations = extractTomlTableMap(content, "notice.model_migrations");
    Object.entries(migrations).forEach(([from, to]) => {
      if (!detectedModels[to]) {
        detectedModels[to] = `Migrated from ${from}`;
      }
      if (!detectedModels[from]) {
        detectedModels[from] = `Legacy model (migrates to ${to})`;
      }
    });
  }

  envModels.forEach(model => {
    if (!detectedModels[model]) {
      detectedModels[model] = "Configured via CODEX_MODELS";
    }
  });

  if (envDefault) {
    detectedModels[envDefault] = detectedModels[envDefault] || "Default from CODEX_DEFAULT_MODEL";
    defaultModel = envDefault;
  }

  if (Object.keys(detectedModels).length > 0) {
    info.models = detectedModels;
    info.defaultModel = defaultModel;
  } else {
    info.defaultModel = defaultModel;
  }

  info.modelOrder = buildOrder(info, info.defaultModel);
}

function applyGeminiOverrides(info: CliInfo): void {
  const envDefault = process.env.GEMINI_DEFAULT_MODEL;
  const envModels = parseEnvModels(process.env.GEMINI_MODELS);
  const observed = collectGeminiModels();

  if (Object.keys(observed.models).length > 0) {
    info.models = observed.models;
    info.modelOrder = observed.order;
    info.defaultModel = observed.order[0];
  }

  envModels.forEach(model => {
    if (!info.models[model]) {
      info.models[model] = "Configured via GEMINI_MODELS";
    }
  });

  if (envDefault) {
    info.models[envDefault] = info.models[envDefault] || "Default from GEMINI_DEFAULT_MODEL";
    info.defaultModel = envDefault;
  }

  info.modelOrder = buildOrder(info, info.defaultModel);
}

function readJsonValue(filePath: string, key: string): string | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content);
    const value = parsed?.[key];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseEnvModels(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(/[,\n]/)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
}

function extractTomlString(content: string, key: string): string | undefined {
  const regex = new RegExp(`^\\s*${escapeRegex(key)}\\s*=\\s*\"([^\"]+)\"`, "m");
  const match = content.match(regex);
  return match ? match[1] : undefined;
}

function extractTomlTableMap(content: string, tableName: string): Record<string, string> {
  const tableRegex = new RegExp(`^\\s*\\[${escapeRegex(tableName)}\\]\\s*$`, "m");
  const tableMatch = content.match(tableRegex);
  if (!tableMatch || tableMatch.index === undefined) {
    return {};
  }

  const startIndex = tableMatch.index + tableMatch[0].length;
  const rest = content.slice(startIndex);
  const nextTable = rest.search(/^\s*\[[^\]]+\]\s*$/m);
  const block = nextTable >= 0 ? rest.slice(0, nextTable) : rest;

  const map: Record<string, string> = {};
  const lineRegex = /"([^"]+)"\s*=\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = lineRegex.exec(block)) !== null) {
    map[match[1]] = match[2];
  }
  return map;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectGeminiModels(): { models: Record<string, string>; order: string[] } {
  const root = path.join(homedir(), ".gemini", "tmp");
  if (!existsSync(root)) {
    return { models: {}, order: [] };
  }

  const candidates: { filePath: string; mtimeMs: number }[] = [];
  const roots = safeReadDir(root);
  roots.forEach(entry => {
    if (!entry.isDirectory()) {
      return;
    }
    const chatsPath = path.join(root, entry.name, "chats");
    if (!existsSync(chatsPath)) {
      return;
    }
    safeReadDir(chatsPath).forEach(file => {
      if (!file.isFile() || !file.name.endsWith(".json")) {
        return;
      }
      const filePath = path.join(chatsPath, file.name);
      try {
        const stat = statSync(filePath);
        candidates.push({ filePath, mtimeMs: stat.mtimeMs });
      } catch {
        return;
      }
    });
  });

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const maxFiles = 200;
  const recent = candidates.slice(0, maxFiles);

  const models: Record<string, { lastSeen: number }> = {};
  for (const candidate of recent) {
    const model = extractGeminiModel(candidate.filePath);
    if (!model) {
      continue;
    }
    const existing = models[model]?.lastSeen ?? 0;
    if (candidate.mtimeMs > existing) {
      models[model] = { lastSeen: candidate.mtimeMs };
    }
  }

  const order = Object.entries(models)
    .sort((a, b) => {
      const versionDiff = extractModelVersion(b[0]) - extractModelVersion(a[0]);
      if (versionDiff !== 0) {
        return versionDiff;
      }
      return b[1].lastSeen - a[1].lastSeen;
    })
    .map(([name]) => name);

  const describedModels: Record<string, string> = {};
  order.forEach(model => {
    describedModels[model] = `Observed in local Gemini sessions (last seen ${formatDate(models[model].lastSeen)})`;
  });

  return { models: describedModels, order };
}

function extractGeminiModel(filePath: string): string | undefined {
  try {
    const content = readFileSync(filePath, "utf-8");
    const match = content.match(/"model"\s*:\s*"([^"]+)"/);
    return match ? match[1] : undefined;
  } catch {
    return undefined;
  }
}

function formatDate(timestampMs: number): string {
  try {
    return new Date(timestampMs).toISOString().slice(0, 10);
  } catch {
    return "unknown";
  }
}

function extractModelVersion(model: string): number {
  const match = model.match(/(\d+(?:\.\d+)?)/);
  if (!match) {
    return 0;
  }
  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeReadDir(dirPath: string): Dirent[] {
  try {
    return readdirSync(dirPath, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }
}

function buildOrder(info: CliInfo, preferred?: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();

  if (preferred && info.models[preferred]) {
    order.push(preferred);
    seen.add(preferred);
  }

  if (info.modelOrder) {
    info.modelOrder.forEach(model => {
      if (!seen.has(model) && info.models[model]) {
        order.push(model);
        seen.add(model);
      }
    });
  }

  Object.keys(info.models).forEach(model => {
    if (!seen.has(model)) {
      order.push(model);
      seen.add(model);
    }
  });

  return order;
}

function pickLatestMatching(info: CliInfo, token: string): string | undefined {
  const normalized = token.toLowerCase();
  const order = info.modelOrder ?? Object.keys(info.models);
  for (const model of order) {
    if (model.toLowerCase().includes(normalized)) {
      return model;
    }
  }
  return undefined;
}
