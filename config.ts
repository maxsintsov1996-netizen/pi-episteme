/**
 * pi-episteme — optional configuration.
 *
 * Settings live in pi's settings.json files under the `piEpisteme` key:
 *   global:  ~/.pi/agent/settings.json
 *   project: <project>/.pi/settings.json  (fields override global per-field)
 *
 * Priority (per field): environment (PI_EPISTEME_*) > config > default.
 * Invalid values at any level are ignored (fall through to the next level).
 *
 * NOTE: the extension on/off mode is NOT a setting — it is per-session
 * state: off by default, enabled for the session with /episteme-on (see
 * index.ts). A legacy `piEpisteme.enabled` field or PI_EPISTEME_ENABLED in a
 * settings file is ignored.
 *
 * Example (.pi/settings.json):
 *   {
 *     "piEpisteme": {
 *       "autoContinue": false,
 *       "hideAnchors": true
 *     }
 *   }
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Raw config shape (all fields optional). Values are decoded/validated
 * inside readPiEpistemeConfig, so a decoded config only ever holds valid
 * values (invalid fields are omitted).
 */
export interface EpistemeConfig {
 /** Auto-continue the next plan step after step compaction. */
 autoContinue?: boolean;
 /** Hide EPISTEME marker anchors in the TUI transcript (display only). */
 hideAnchors?: boolean;
 /** Token budget per compaction layer; 0 disables the budget. */
 layerTokenBudget?: number;
}

export interface EpistemeSettings {
 autoContinue: boolean;
 hideAnchors: boolean;
 layerTokenBudget: number;
}

export const EPISTEME_DEFAULTS: EpistemeSettings = {
 autoContinue: true,
 hideAnchors: true,
 layerTokenBudget: 16384,
};

const ENV = {
 autoContinue: "PI_EPISTEME_AUTO_CONTINUE",
 hideAnchors: "PI_EPISTEME_HIDE_ANCHORS",
 layerTokenBudget: "PI_EPISTEME_LAYER_TOKEN_BUDGET",
} as const;

type JsonScalar = number | string | boolean | null;

/** Non-empty env value (undefined when unset or blank). */
function envValue(name: string): string | undefined {
 const v = process.env[name];
 return v === undefined || v.trim() === "" ? undefined : v;
}

/** Parse a strict boolean env value, or undefined when invalid. */
function envBoolean(name: string): boolean | undefined {
 const value = envValue(name)?.trim().toLowerCase();
 if (value === "1" || value === "true" || value === "on") {
  return true;
 }
 if (value === "0" || value === "false" || value === "off") {
  return false;
 }
 return undefined;
}

/**
 * Read the `piEpisteme` key from global then project settings.json
 * (project fields win) and decode it: invalid field values are dropped,
 * so the result contains only valid values.
 */
export function readPiEpistemeConfig(
 cwd: string,
 globalSettingsPath?: string,
): EpistemeConfig {
 const files = [
  globalSettingsPath ?? join(getAgentDir(), "settings.json"),
  join(cwd, CONFIG_DIR_NAME, "settings.json"),
 ];
 const merged: EpistemeConfig = {};
 for (const file of files) {
  let raw: unknown;
  try {
   raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
   continue; // no settings file at this location
  }
  const section = (raw as { piEpisteme?: unknown } | null)?.piEpisteme;
  if (!section || typeof section !== "object" || Array.isArray(section)) {
   continue;
  }
  const s = section as Record<string, JsonScalar>;
  if (typeof s.autoContinue === "boolean") {
   merged.autoContinue = s.autoContinue;
  }
  if (typeof s.hideAnchors === "boolean") {
   merged.hideAnchors = s.hideAnchors;
  }
  const budget = normalizeLayerTokenBudget(s.layerTokenBudget);
  if (budget !== undefined) {
   merged.layerTokenBudget = budget;
  }
 }
 return merged;
}

/** Resolve the effective autoContinue: env > config > default. */
function resolveAutoContinue(cfgAuto: boolean | undefined): boolean {
 const envAuto = envBoolean(ENV.autoContinue);
 if (envAuto !== undefined) {
  return envAuto;
 }
 if (cfgAuto !== undefined) {
  return cfgAuto;
 }
 return EPISTEME_DEFAULTS.autoContinue;
}

/** Resolve the effective hideAnchors: env > config > default. */
function resolveHideAnchors(cfgHide: boolean | undefined): boolean {
 const envHide = envBoolean(ENV.hideAnchors);
 if (envHide !== undefined) {
  return envHide;
 }
 if (cfgHide !== undefined) {
  return cfgHide;
 }
 return EPISTEME_DEFAULTS.hideAnchors;
}

/**
 * One validity rule for `layerTokenBudget`, shared by the settings-file and
 * environment paths: a whole number >= 0 that survives as a safe integer.
 * "99999999999999999999" is an integer (1e20) and would silently act as
 * "rollover disabled", so the range check matters as much as the shape check.
 */
export function normalizeLayerTokenBudget(value: unknown): number | undefined {
 if (typeof value === "number") {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
 }
 if (typeof value === "string") {
  const text = value.trim();
  if (!/^\d+$/.test(text)) return undefined;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
 }
 return undefined;
}

/** Resolve the effective layerTokenBudget: env > config > default. */
function resolveLayerTokenBudget(cfgBudget: number | undefined): number {
 const envBudget = envValue(ENV.layerTokenBudget);
 if (envBudget !== undefined) {
  const value = normalizeLayerTokenBudget(envBudget);
  if (value !== undefined) {
   return value;
  }
 }
 if (cfgBudget !== undefined) {
  return cfgBudget;
 }
 return EPISTEME_DEFAULTS.layerTokenBudget;
}

/**
 * Resolve effective settings with priority: env > config > default.
 */
export function resolveEpistemeSettings(
 cwd: string,
 globalSettingsPath?: string,
): EpistemeSettings {
 const cfg = readPiEpistemeConfig(cwd, globalSettingsPath);
 return {
  autoContinue: resolveAutoContinue(cfg.autoContinue),
  hideAnchors: resolveHideAnchors(cfg.hideAnchors),
  layerTokenBudget: resolveLayerTokenBudget(cfg.layerTokenBudget),
 };
}
