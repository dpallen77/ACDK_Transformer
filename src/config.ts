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
  // Individual files may omit stackName; the merged result may not.
  if (merged.stackName === undefined) {
    throw new Error(`"stackName" must be set in environments/common.json or environments/${envName}.json`);
  }
  return merged;
}

/** Every resources/*.json file, with same-named lists concatenated. */
export function loadResources(projectDir: string): JsonObject {
  const dir = path.join(projectDir, "resources");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
  const out: JsonObject = {};
  for (const file of files) {
    const content = readJson(path.join(dir, file));
    validate("resources", content, `resources/${file}`);
    for (const [key, value] of Object.entries(content)) {
      if (key === "$schema" || !Array.isArray(value)) continue;
      const existing = out[key];
      out[key] = Array.isArray(existing) ? [...existing, ...value] : value;
    }
  }
  return out;
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
