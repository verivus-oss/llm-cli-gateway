import { Dirent, existsSync, readFileSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import path from "path";
import { parse as parseToml } from "toml";
import type { CliType } from "./session-manager.js";

type ModelSource = "fallback" | "observed" | "config" | "env";
type ModelConfidence = "low" | "medium" | "high";

export interface ModelMetadata {
  source: ModelSource;
  sourceDetail: string;
  confidence: ModelConfidence;
  lastSeen?: string;
}

export interface CliInfo {
  description: string;
  models: Record<string, string>;
  defaultModel?: string;
  defaultModelSource?: string;
  modelOrder?: string[];
  aliases?: Record<string, string>;
  modelMetadata?: Record<string, ModelMetadata>;
  warnings?: string[];
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
    // Note: no hardcoded `defaultModel`. Let Codex CLI pick its own built-in default
    // unless an explicit value is found via config.toml / env vars in applyCodexOverrides.
    // This prevents the gateway from pinning a model that may become deprecated upstream.
    description: "OpenAI's Codex CLI - best for code execution in sandboxed environments",
    models: {
      "gpt-5.4": "Frontier coding and professional-work model. Best for: most Codex tasks, long-running agentic work",
      "gpt-5.3-codex": "Specialized Codex model. Best for: agentic coding workflows with Codex-tuned behavior",
      "gpt-5.2": "Strong general-purpose GPT-5 model. Best for: broad coding and reasoning tasks",
      "gpt-5-pro": "Highest-capability GPT-5 model. Best for: deep reasoning and difficult professional workflows"
    },
    modelOrder: ["gpt-5.3-codex", "gpt-5.4", "gpt-5.2", "gpt-5-pro"]
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
const MAX_GEMINI_HISTORY_FILES = 200;
const MAX_GEMINI_HISTORY_FILE_BYTES = 2 * 1024 * 1024;
const SOURCE_PRIORITY: Record<ModelSource, number> = {
  fallback: 0,
  observed: 1,
  config: 2,
  env: 3
};

let cachedInfo: { loadedAt: number; info: CliInfoMap } | null = null;

export function getCliInfo(forceRefresh = false): CliInfoMap {
  if (!forceRefresh && cachedInfo && Date.now() - cachedInfo.loadedAt < MODEL_CACHE_TTL_MS) {
    return cachedInfo.info;
  }

  const info = buildCliInfo();
  cachedInfo = { loadedAt: Date.now(), info };
  return info;
}

export function clearModelRegistryCache(): void {
  cachedInfo = null;
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
    // If no default is configured, return undefined so the CLI picks its own
    // built-in default. Avoids passing the literal string "default"/"latest"
    // as a model name to the CLI.
    return cliInfo.defaultModel;
  }

  const alias = resolveConfiguredAlias(cliInfo, normalized);
  if (alias !== undefined) {
    return alias;
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
  const cloned: CliInfo = {
    description: source.description,
    models: { ...source.models },
    defaultModel: source.defaultModel,
    defaultModelSource: source.defaultModelSource,
    modelOrder: source.modelOrder ? [...source.modelOrder] : undefined,
    aliases: source.aliases ? { ...source.aliases } : undefined,
    modelMetadata: source.modelMetadata ? { ...source.modelMetadata } : {},
    warnings: source.warnings ? [...source.warnings] : []
  };

  Object.keys(cloned.models).forEach(model => {
    cloned.modelMetadata![model] = cloned.modelMetadata![model] ?? {
      source: "fallback",
      sourceDetail: "Bundled fallback registry",
      confidence: "low"
    };
  });

  return cloned;
}

function addWarning(info: CliInfo, warning: string): void {
  info.warnings = info.warnings ?? [];
  if (!info.warnings.includes(warning)) {
    info.warnings.push(warning);
  }
}

function isValidModelName(model: string): boolean {
  return model.length > 0 && !/[\u0000-\u001f\u007f]/.test(model) && !/\s/.test(model);
}

function addModel(
  info: CliInfo,
  model: string,
  description: string,
  metadata: ModelMetadata,
  options: { preferDescription?: boolean } = {}
): void {
  const normalized = model.trim();
  if (!isValidModelName(normalized)) {
    addWarning(info, `Ignored invalid model name from ${metadata.sourceDetail}`);
    return;
  }

  const existingMetadata = info.modelMetadata?.[normalized];
  const existingPriority = existingMetadata ? SOURCE_PRIORITY[existingMetadata.source] : -1;
  const incomingPriority = SOURCE_PRIORITY[metadata.source];

  if (!info.models[normalized] || options.preferDescription || incomingPriority > existingPriority) {
    info.models[normalized] = description;
  }

  info.modelMetadata = info.modelMetadata ?? {};
  if (!existingMetadata || incomingPriority >= existingPriority) {
    info.modelMetadata[normalized] = metadata;
  }
}

function setDefaultModel(info: CliInfo, model: string | undefined, source: string, sourceType: ModelSource): void {
  const normalized = model?.trim();
  if (!normalized) {
    return;
  }

  if (!isValidModelName(normalized)) {
    addWarning(info, `Ignored invalid default model from ${source}`);
    return;
  }

  addModel(info, normalized, `Configured default from ${source}`, {
    source: sourceType,
    sourceDetail: source,
    confidence: sourceType === "env" ? "high" : "medium"
  });
  info.defaultModel = normalized;
  info.defaultModelSource = source;
}

function addAlias(info: CliInfo, alias: string, target: string, source: string): void {
  const normalizedAlias = alias.trim().toLowerCase();
  const normalizedTarget = target.trim();
  if (!normalizedAlias || /\s/.test(normalizedAlias) || !normalizedTarget) {
    addWarning(info, `Ignored invalid alias from ${source}`);
    return;
  }
  if (normalizedTarget !== "default" && !isValidModelName(normalizedTarget)) {
    addWarning(info, `Ignored invalid alias target from ${source}`);
    return;
  }
  info.aliases = info.aliases ?? {};
  info.aliases[normalizedAlias] = normalizedTarget;
}

function resolveConfiguredAlias(info: CliInfo, normalizedAlias: string): string | undefined {
  const target = info.aliases?.[normalizedAlias];
  if (!target) {
    return undefined;
  }
  if (target === "default") {
    return info.defaultModel;
  }
  return target;
}

function addEnvModels(info: CliInfo, envName: string): void {
  const entries = parseEnvModelEntries(process.env[envName], envName);
  entries.forEach(entry => {
    addModel(info, entry.model, entry.description ?? `Configured via ${envName}`, {
      source: "env",
      sourceDetail: envName,
      confidence: "high"
    }, { preferDescription: Boolean(entry.description) });
  });
}

function addEnvAliases(info: CliInfo, cli: CliType, envName: string): void {
  parseEnvAliasEntries(process.env[envName], envName, cli).forEach(entry => {
    addAlias(info, entry.alias, entry.target, envName);
  });
}

function addGlobalEnvAliases(info: CliInfo, cli: CliType): void {
  parseEnvAliasEntries(process.env.LLM_GATEWAY_MODEL_ALIASES, "LLM_GATEWAY_MODEL_ALIASES", cli).forEach(entry => {
    addAlias(info, entry.alias, entry.target, "LLM_GATEWAY_MODEL_ALIASES");
  });
}

function applyClaudeOverrides(info: CliInfo): void {
  const settingsPath = process.env.CLAUDE_SETTINGS_PATH || path.join(homedir(), ".claude", "settings.json");
  const settingsLocalPath = process.env.CLAUDE_SETTINGS_LOCAL_PATH || path.join(homedir(), ".claude", "settings.local.json");
  const envDefault = process.env.CLAUDE_DEFAULT_MODEL;
  const localDefault = readJsonStringValue(settingsLocalPath, [["model"], ["model", "name"]], info);
  const settingsDefault = readJsonStringValue(settingsPath, [["model"], ["model", "name"]], info);

  if (settingsDefault) {
    setDefaultModel(info, settingsDefault, settingsPath, "config");
  }
  if (localDefault) {
    setDefaultModel(info, localDefault, settingsLocalPath, "config");
  }
  if (envDefault) {
    setDefaultModel(info, envDefault, "CLAUDE_DEFAULT_MODEL", "env");
  }

  addEnvModels(info, "CLAUDE_MODELS");
  addEnvAliases(info, "claude", "CLAUDE_MODEL_ALIASES");
  addGlobalEnvAliases(info, "claude");

  info.modelOrder = buildOrder(info, info.defaultModel);
}

function applyCodexOverrides(info: CliInfo): void {
  const configPath = process.env.CODEX_CONFIG_PATH || path.join(homedir(), ".codex", "config.toml");
  const envDefault = process.env.CODEX_DEFAULT_MODEL;

  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, "utf-8");
      const parsed = parseToml(content);
      const model = readStringProperty(parsed, "model");
      setDefaultModel(info, model, configPath, "config");

      const profiles = readRecordProperty(parsed, "profiles");
      Object.entries(profiles).forEach(([profileName, profile]) => {
        const profileModel = readStringProperty(profile, "model");
        if (profileModel) {
          addModel(info, profileModel, `Configured in Codex profile '${profileName}'`, {
            source: "config",
            sourceDetail: `${configPath} profile ${profileName}`,
            confidence: "medium"
          });
        }
      });

      const notice = readRecordProperty(parsed, "notice");
      const migrations = readRecordProperty(notice, "model_migrations");
      Object.entries(migrations).forEach(([from, to]) => {
        if (typeof to !== "string") {
          return;
        }
        addModel(info, to, `Migration target for ${from}`, {
          source: "config",
          sourceDetail: `${configPath} notice.model_migrations`,
          confidence: "medium"
        });
        addModel(info, from, `Legacy model (migrates to ${to})`, {
          source: "config",
          sourceDetail: `${configPath} notice.model_migrations`,
          confidence: "medium"
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addWarning(info, `Could not parse Codex config ${configPath}: ${message}`);
    }
  }

  addEnvModels(info, "CODEX_MODELS");
  addEnvAliases(info, "codex", "CODEX_MODEL_ALIASES");
  addGlobalEnvAliases(info, "codex");

  if (envDefault) {
    setDefaultModel(info, envDefault, "CODEX_DEFAULT_MODEL", "env");
  }

  info.modelOrder = buildOrder(info, info.defaultModel);
}

function applyGeminiOverrides(info: CliInfo): void {
  const settingsPath = process.env.GEMINI_SETTINGS_PATH || path.join(homedir(), ".gemini", "settings.json");
  const settingsDefault = readJsonStringValue(
    settingsPath,
    [["model"], ["model", "name"], ["selectedModel"], ["defaultModel"]],
    info
  );
  const envDefault = process.env.GEMINI_DEFAULT_MODEL;

  if (settingsDefault) {
    setDefaultModel(info, settingsDefault, settingsPath, "config");
  }

  if (!isModelDiscoveryDisabled()) {
    const observed = collectGeminiModels();
    observed.forEach(observation => {
      addModel(info, observation.model, `Observed in local Gemini sessions (last seen ${observation.lastSeen})`, {
        source: "observed",
        sourceDetail: observation.filePath,
        confidence: "low",
        lastSeen: observation.lastSeen
      });
    });
  }

  addEnvModels(info, "GEMINI_MODELS");
  addEnvAliases(info, "gemini", "GEMINI_MODEL_ALIASES");
  addGlobalEnvAliases(info, "gemini");

  if (envDefault) {
    setDefaultModel(info, envDefault, "GEMINI_DEFAULT_MODEL", "env");
  }

  info.modelOrder = buildOrder(info, info.defaultModel);
}

function readJsonStringValue(filePath: string, paths: string[][], info?: CliInfo): string | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content);
    for (const pathParts of paths) {
      const value = readPath(parsed, pathParts);
      if (typeof value === "string" && value.trim()) {
        return value;
      }
    }
    return undefined;
  } catch (error) {
    if (info) {
      const message = error instanceof Error ? error.message : String(error);
      addWarning(info, `Could not parse JSON config ${filePath}: ${message}`);
    }
    return undefined;
  }
}

function readPath(value: unknown, pathParts: string[]): unknown {
  let current = value;
  for (const part of pathParts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function readStringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const prop = (value as Record<string, unknown>)[key];
  return typeof prop === "string" && prop.trim() ? prop : undefined;
}

function readRecordProperty(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const prop = (value as Record<string, unknown>)[key];
  return prop && typeof prop === "object" && !Array.isArray(prop) ? prop as Record<string, unknown> : {};
}

interface EnvModelEntry {
  model: string;
  description?: string;
}

function parseEnvModelEntries(value: string | undefined, source: string): EnvModelEntry[] {
  if (!value) {
    return [];
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.flatMap(entry => {
          if (typeof entry === "string") {
            return [{ model: entry }];
          }
          if (entry && typeof entry === "object") {
            const record = entry as Record<string, unknown>;
            const model = firstString(record.model, record.id, record.name);
            const description = firstString(record.description, record.desc);
            return model ? [{ model, description }] : [];
          }
          return [];
        });
      }
      if (parsed && typeof parsed === "object") {
        return Object.entries(parsed as Record<string, unknown>).flatMap(([model, description]) => {
          if (typeof description === "string") {
            return [{ model, description }];
          }
          return [{ model }];
        });
      }
    } catch {
      return [{ model: trimmed, description: `Configured via ${source}` }];
    }
  }

  return trimmed
    .split(/[,\n]/)
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => {
      const eqIndex = entry.indexOf("=");
      if (eqIndex > 0) {
        return {
          model: entry.slice(0, eqIndex).trim(),
          description: entry.slice(eqIndex + 1).trim() || undefined
        };
      }
      return { model: entry };
    });
}

interface EnvAliasEntry {
  alias: string;
  target: string;
}

function parseEnvAliasEntries(value: string | undefined, source: string, cli: CliType): EnvAliasEntry[] {
  if (!value) {
    return [];
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  const entries: EnvAliasEntry[] = [];
  const addEntry = (rawAlias: string, rawTarget: unknown) => {
    if (typeof rawTarget !== "string") {
      return;
    }
    let alias = rawAlias.trim();
    if (source === "LLM_GATEWAY_MODEL_ALIASES") {
      const prefix = `${cli}.`;
      if (!alias.startsWith(prefix)) {
        return;
      }
      alias = alias.slice(prefix.length);
    }
    entries.push({ alias, target: rawTarget });
  };

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        Object.entries(parsed as Record<string, unknown>).forEach(([alias, target]) => addEntry(alias, target));
        return entries;
      }
    } catch {
      return [];
    }
  }

  trimmed.split(/[,\n]/).forEach(entry => {
    const eqIndex = entry.indexOf("=");
    if (eqIndex <= 0) {
      return;
    }
    addEntry(entry.slice(0, eqIndex), entry.slice(eqIndex + 1));
  });

  return entries;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

interface GeminiObservation {
  model: string;
  lastSeen: string;
  lastSeenMs: number;
  filePath: string;
}

function isModelDiscoveryDisabled(): boolean {
  return process.env.LLM_GATEWAY_DISABLE_MODEL_DISCOVERY === "1"
    || process.env.GEMINI_DISABLE_HISTORY_DISCOVERY === "1";
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function collectGeminiModels(): GeminiObservation[] {
  const root = process.env.GEMINI_HISTORY_ROOT || path.join(homedir(), ".gemini", "tmp");
  if (!existsSync(root)) {
    return [];
  }

  const maxFiles = parsePositiveInt(process.env.GEMINI_HISTORY_MAX_FILES, MAX_GEMINI_HISTORY_FILES);
  const maxFileBytes = parsePositiveInt(process.env.GEMINI_HISTORY_MAX_FILE_BYTES, MAX_GEMINI_HISTORY_FILE_BYTES);
  const candidates: { filePath: string; mtimeMs: number; size: number }[] = [];
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
        if (stat.size <= maxFileBytes) {
          candidates.push({ filePath, mtimeMs: stat.mtimeMs, size: stat.size });
        }
      } catch {
        return;
      }
    });
  });

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const recent = candidates.slice(0, maxFiles);

  const models: Record<string, GeminiObservation> = {};
  for (const candidate of recent) {
    extractGeminiModels(candidate.filePath).forEach(model => {
      const existing = models[model]?.lastSeenMs ?? 0;
      if (candidate.mtimeMs > existing) {
        models[model] = {
          model,
          lastSeen: formatDate(candidate.mtimeMs),
          lastSeenMs: candidate.mtimeMs,
          filePath: candidate.filePath
        };
      }
    });
  }

  return Object.values(models)
    .sort((a, b) => {
      const versionDiff = extractModelVersion(b.model) - extractModelVersion(a.model);
      if (versionDiff !== 0) {
        return versionDiff;
      }
      return b.lastSeenMs - a.lastSeenMs;
    });
}

function extractGeminiModels(filePath: string): string[] {
  try {
    const content = readFileSync(filePath, "utf-8");
    const found = new Set<string>();
    try {
      collectModelValues(JSON.parse(content), found);
    } catch {
      const regex = /"model(?:Name|Id)?"\s*:\s*"([^"]+)"/g;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        found.add(match[1]);
      }
    }
    return [...found].filter(isValidModelName).slice(0, 20);
  } catch {
    return [];
  }
}

function collectModelValues(value: unknown, found: Set<string>): void {
  if (!value || found.size >= 20) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(entry => collectModelValues(entry, found));
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  Object.entries(value as Record<string, unknown>).forEach(([key, child]) => {
    if ((key === "model" || key === "modelName" || key === "modelId") && typeof child === "string") {
      found.add(child);
    } else {
      collectModelValues(child, found);
    }
  });
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
  const candidates = Object.keys(info.models)
    .filter(model => model.toLowerCase().includes(normalized))
    .sort((a, b) => {
      const versionDiff = extractModelVersion(b) - extractModelVersion(a);
      if (versionDiff !== 0) {
        return versionDiff;
      }
      const aMetadata = info.modelMetadata?.[a];
      const bMetadata = info.modelMetadata?.[b];
      const priorityDiff = (bMetadata ? SOURCE_PRIORITY[bMetadata.source] : 0)
        - (aMetadata ? SOURCE_PRIORITY[aMetadata.source] : 0);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      return a.localeCompare(b);
    }
    );
  return candidates[0];
}
