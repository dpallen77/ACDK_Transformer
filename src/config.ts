import fs from "node:fs";
import path from "node:path";
import { validate } from "./validate.js";

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readJson(file: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Could not read ${file}: ${(err as Error).message}`);
  }
  if (!isObject(parsed)) throw new Error(`${file} must contain a JSON object`);
  return parsed;
}

/** Objects merge key by key; arrays and scalars in `override` replace `base`. */
export function deepMerge(base: JsonObject, override: JsonObject): JsonObject {
  const out: JsonObject = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    out[key] = isObject(existing) && isObject(value) ? deepMerge(existing, value) : value;
  }
  return out;
}

/** environments/common.json with environments/<env>.json merged over it. */
export function loadEnvironment(projectDir: string, envName: string): JsonObject {
  const dir = path.join(projectDir, "environments");
  const envFile = path.join(dir, `${envName}.json`);
  if (!fs.existsSync(envFile)) throw new Error(`No environment file: ${envFile}`);
  const commonFile = path.join(dir, "common.json");
  const common = fs.existsSync(commonFile) ? readJson(commonFile) : {};
  const envValues = readJson(envFile);
  validate("environment", common, `environments/common.json`);
  validate("environment", envValues, `environments/${envName}.json`);

  const merged = deepMerge(common, envValues);
  // Individual files may omit these; the merged result may not.
  for (const key of ["stackName", "region"]) {
    if (merged[key] === undefined) {
      throw new Error(`"${key}" must be set in environments/common.json or environments/${envName}.json`);
    }
  }
  return merged;
}

/**
 * The environment as seen from one region: `regionOverrides.<region>` merged in,
 * and `region` set to that region (so `${env.region}` always means "this region").
 */
export function environmentForRegion(env: JsonObject, region: string): JsonObject {
  const { regionOverrides, ...base } = env;
  const overrides = isObject(regionOverrides) && isObject(regionOverrides[region]) ? regionOverrides[region] : {};
  const regional = { ...deepMerge(base, overrides), region };
  validate("environment", regional, `Environment values for ${region}`);
  return regional;
}

/** One resource entry (a bucket, a web app, ...) and the file it came from. */
export interface ResourceEntry {
  kind: string;
  item: JsonObject;
  source: string;
}

/** Every entry in every resources/*.json file. Names must be unique across all of them. */
export function loadResources(projectDir: string): ResourceEntry[] {
  const dir = path.join(projectDir, "resources");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
  const entries: ResourceEntry[] = [];
  const seen = new Map<string, string>();
  for (const file of files) {
    const source = `resources/${file}`;
    const content = readJson(path.join(dir, file));
    validate("resources", content, source);
    for (const [kind, list] of Object.entries(content)) {
      if (kind === "$schema" || !Array.isArray(list)) continue;
      for (const item of list) {
        if (!isObject(item)) continue;
        const name = String(item.name);
        const first = seen.get(name);
        if (first) {
          const where = first === source ? `twice in ${source}` : `in both ${first} and ${source}`;
          throw new Error(`The name "${name}" is used ${where}; resource names must be unique`);
        }
        seen.set(name, source);
        entries.push({ kind, item, source });
      }
    }
  }
  return entries;
}

/**
 * Work out which regions each resource goes to and resolve its placeholders with that
 * region's environment values. Returns the resources to deploy, grouped by region.
 * A resource without `regions` goes to the environment's `region`.
 */
export function planRegions(env: JsonObject, entries: ResourceEntry[]): Map<string, JsonObject> {
  const plan = new Map<string, JsonObject>();
  const envByRegion = new Map<string, JsonObject>();
  const regionalEnv = (region: string): JsonObject => {
    if (!envByRegion.has(region)) envByRegion.set(region, environmentForRegion(env, region));
    return envByRegion.get(region)!;
  };
  for (const { kind, item, source } of entries) {
    const { regions: rawRegions, ...rest } = item;
    const where = `${source} ("${String(item.name)}")`;
    const regions = rawRegions === undefined ? [env.region] : resolvePlaceholders(rawRegions, env, `${where}.regions`);
    if (!Array.isArray(regions) || regions.length === 0 || !regions.every((r) => typeof r === "string")) {
      throw new Error(`${where}: "regions" must be a non-empty list of region names`);
    }
    for (const region of new Set(regions as string[])) {
      if (!plan.has(region)) plan.set(region, {});
      const forRegion = plan.get(region)!;
      const resolved = resolvePlaceholders(rest, regionalEnv(region), where);
      forRegion[kind] = [...((forRegion[kind] as Json[] | undefined) ?? []), resolved];
    }
  }
  return plan;
}

const PLACEHOLDER = /\$\{env\.([A-Za-z0-9_.-]+)\}/g;
const WHOLE_PLACEHOLDER = /^\$\{env\.([A-Za-z0-9_.-]+)\}$/;

function lookup(env: JsonObject, dotted: string, where: string): Json {
  let current: Json = env;
  for (const part of dotted.split(".")) {
    if (!isObject(current) || !(part in current)) {
      throw new Error(`Unknown placeholder \${env.${dotted}} at ${where}`);
    }
    current = current[part] as Json;
  }
  return current;
}

/**
 * Replace ${env.path} placeholders. A string that is exactly one placeholder takes the
 * value as-is (so numbers stay numbers); placeholders inside longer strings are joined in.
 */
export function resolvePlaceholders(value: Json, env: JsonObject, where = "resources"): Json {
  if (typeof value === "string") {
    const whole = WHOLE_PLACEHOLDER.exec(value);
    if (whole) return lookup(env, whole[1]!, where);
    return value.replace(PLACEHOLDER, (_m, dotted: string) => {
      const found = lookup(env, dotted, where);
      if (isObject(found) || Array.isArray(found)) {
        throw new Error(`\${env.${dotted}} at ${where} is an object/list and can't be embedded in text`);
      }
      return String(found);
    });
  }
  if (Array.isArray(value)) return value.map((v, i) => resolvePlaceholders(v, env, `${where}[${i}]`));
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolvePlaceholders(v, env, `${where}.${k}`)]),
    );
  }
  return value;
}
