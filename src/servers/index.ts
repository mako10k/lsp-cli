import path from "node:path";
import { rustAnalyzerProfile } from "./rustAnalyzer";
import { typescriptLanguageServerProfile } from "./typescriptLanguageServer";
import type { ServerProfile } from "../lsp/LspClient";
import { loadConfigFromDisk, type ServerConfig } from "./config";

function mergeServerConfig(base: ServerConfig | undefined, override: ServerConfig | undefined): ServerConfig | undefined {
  if (!base && !override) return undefined;
  return {
    command: override?.command ?? base?.command,
    preset: override?.preset ?? base?.preset,
    args: override?.args ?? base?.args,
    initializationOptions: override?.initializationOptions ?? base?.initializationOptions,
    languageIdByExt: { ...(base?.languageIdByExt ?? {}), ...(override?.languageIdByExt ?? {}) },
    defaultLanguageId: override?.defaultLanguageId ?? base?.defaultLanguageId,
    cwd: override?.cwd ?? base?.cwd,
    env: { ...(base?.env ?? {}), ...(override?.env ?? {}) },
    waitMs: override?.waitMs ?? base?.waitMs,
    warmup: override?.warmup ?? base?.warmup
  };
}

function applyPreset(cfg: ServerConfig | undefined, presets: Record<string, ServerConfig> | undefined): ServerConfig | undefined {
  if (!cfg?.preset) return cfg;
  const preset = presets?.[cfg.preset];
  if (!preset) throw new Error(`unknown server preset: ${cfg.preset}`);
  const { preset: _preset, ...rest } = cfg;
  return mergeServerConfig(preset, rest);
}

function languageIdForPathFromCfg(cfg: Pick<ServerConfig, "languageIdByExt" | "defaultLanguageId">): (filePath: string) => string {
  const byExt = cfg.languageIdByExt ?? {};
  const defaultLanguageId = cfg.defaultLanguageId ?? "plaintext";
  return (filePath: string) => {
    const ext = path.extname(filePath);
    return byExt[ext] ?? defaultLanguageId;
  };
}

function getBuiltInProfile(name: string): ServerProfile | null {
  switch (name) {
    case "rust-analyzer":
      return rustAnalyzerProfile();
    case "typescript-language-server":
      return typescriptLanguageServerProfile();
    default:
      return null;
  }
}

function applyConfigToProfile(name: string, base: ServerProfile, cfg: ServerConfig | undefined): ServerProfile {
  if (!cfg) return base;
  const hasLangOverride = cfg.languageIdByExt || cfg.defaultLanguageId;

  return {
    ...base,
    name,
    command: cfg.command ?? base.command,
    args: cfg.args ?? base.args,
    initializationOptions: cfg.initializationOptions ?? base.initializationOptions,
    cwd: cfg.cwd ?? base.cwd,
    env: cfg.env ? { ...(base.env ?? {}), ...cfg.env } : base.env,
    waitMs: cfg.waitMs ?? base.waitMs,
    warmup: cfg.warmup ?? base.warmup,
    languageIdForPath: hasLangOverride ? languageIdForPathFromCfg(cfg) : base.languageIdForPath
  };
}

export function getServerProfile(
  name: string,
  rootPath: string,
  configPath?: string,
  overrideCmd?: string
): ServerProfile {
  const cfg = loadConfigFromDisk(rootPath, configPath);

  const presets = cfg?.presets;
  const augment = applyPreset(cfg?.augment?.[name], presets);
  const serverEntry = applyPreset(cfg?.servers?.[name], presets);

  const mergedCfg = mergeServerConfig(augment, serverEntry);

  const builtIn = getBuiltInProfile(name);

  let profile: ServerProfile;

  if (builtIn) {
    profile = applyConfigToProfile(name, builtIn, mergedCfg);
  } else {
    const command = mergedCfg?.command;
    if (!command) throw new Error(`unknown server profile: ${name}`);

    profile = {
      name,
      command,
      args: mergedCfg?.args ?? [],
      initializationOptions: mergedCfg?.initializationOptions,
      cwd: mergedCfg?.cwd,
      env: mergedCfg?.env,
      waitMs: mergedCfg?.waitMs,
      warmup: mergedCfg?.warmup,
      languageIdForPath: languageIdForPathFromCfg(mergedCfg ?? {})
    };
  }

  if (!overrideCmd) return profile;
  return { ...profile, command: overrideCmd };
}
