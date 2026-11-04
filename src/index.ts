import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { environmentForRegion, loadEnvironment, loadResources, planRegions } from "./config.js";
import { synthesize, type EnvironmentConfig, type ResourcesConfig } from "./synth.js";
import { validate } from "./validate.js";

const USAGE = "Usage: acdk synth --env <name> [--dir <project dir>] [--out <output dir>]";

export function main(argv: string[]): void {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      env: { type: "string" },
      dir: { type: "string", default: "." },
      out: { type: "string" },
    },
  });
  if (positionals[0] !== "synth" || !values.env) {
    console.error(USAGE);
    process.exit(1);
  }

  const projectDir = values.dir;
  const outDir = values.out ?? projectDir;
  try {
    const env = loadEnvironment(projectDir, values.env);
    const entries = loadResources(projectDir);
    if (entries.length === 0) throw new Error(`No resources found in ${path.join(projectDir, "resources")}`);
    const plan = planRegions(env, entries);

    // Build every template before writing any, so an error leaves no partial output.
    const outputs: Array<[string, string]> = [];
    for (const [region, resources] of plan) {
      // Check again with real values: a placeholder may bring in a wrong type or value.
      validate("resources", resources, `Resources for "${values.env}" in ${region}`);
      const regionalEnv = environmentForRegion(env, region);
      const yamlText = synthesize(regionalEnv as unknown as EnvironmentConfig, resources as ResourcesConfig);
      outputs.push([path.join(outDir, `template.${values.env}.${region}.yaml`), yamlText]);
    }
    for (const [file, text] of outputs) {
      fs.writeFileSync(file, text);
      console.log(`Wrote ${file}`);
    }
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

main(process.argv.slice(2));
