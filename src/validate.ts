import fs from "node:fs";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";

const schemaDir = new URL("../schemas/", import.meta.url);

function loadSchema(file: string): object {
  return JSON.parse(fs.readFileSync(new URL(file, schemaDir), "utf8")) as object;
}

const ajv = new Ajv({ allErrors: true });
const validators = {
  environment: ajv.compile(loadSchema("environment.schema.json")),
  resources: ajv.compile(loadSchema("resources.schema.json")),
};

export type SchemaName = keyof typeof validators;

/** One error's reason, without its location. */
function reason(e: ErrorObject): string {
  switch (e.keyword) {
    case "additionalProperties":
      return `unknown field "${(e.params as { additionalProperty: string }).additionalProperty}"`;
    case "required":
      return `missing required field "${(e.params as { missingProperty: string }).missingProperty}"`;
    case "enum":
      return `must be one of ${(e.params as { allowedValues: unknown[] }).allowedValues.join(", ")}`;
    default:
      return e.message ?? "invalid value";
  }
}

/** Turn Ajv's errors into short, readable lines like `/webApps/0: unknown field "memmory"`. */
function describe(errors: ErrorObject[]): string[] {
  // Errors from inside an anyOf branch are summarised by the anyOf error itself.
  const anyOfPaths = new Set(
    errors.filter((e) => e.keyword === "anyOf").map((e) => e.schemaPath.replace(/\/anyOf$/, "/anyOf/")),
  );
  const lines = new Set<string>();
  for (const e of errors) {
    if ([...anyOfPaths].some((p) => e.schemaPath.startsWith(p))) continue;
    // The placeholder alternative is only ever used inside an anyOf.
    if (e.schemaPath.startsWith("#/definitions/placeholder/")) continue;
    const at = e.instancePath || "/";
    if (e.keyword === "anyOf") {
      const branches = errors.filter((b) => b.schemaPath.startsWith(e.schemaPath + "/"));
      const reasons = [...new Set(branches.map(reason))].join(", ");
      lines.add(`${at}: ${reasons || "invalid value"} (or an \${env.…} placeholder)`);
    } else {
      lines.add(`${at}: ${reason(e)}`);
    }
  }
  return [...lines];
}

/** Throw a readable error if `data` doesn't match the named schema. */
export function validate(schema: SchemaName, data: unknown, source: string): void {
  const check: ValidateFunction = validators[schema];
  if (check(data)) return;
  const lines = describe(check.errors ?? []).map((l) => `  ${l}`);
  throw new Error(`${source} is not valid:\n${lines.join("\n")}`);
}
