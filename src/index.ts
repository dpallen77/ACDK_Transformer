import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadEnvironment, loadResources, resolvePlaceholders } from "./config.js";
import { synthesize, type EnvironmentConfig, type ResourcesConfig } from "./synth.js";

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
    if (typeof env.stackName !== "string") {
      throw new Error(`"stackName" must be set in environments/common.json or ${values.env}.json`);
    }
    const resources = resolvePlaceholders(loadResources(projectDir), env);

    const yamlText = synthesize(env as unknown as EnvironmentConfig, resources as ResourcesConfig);
    const outFile = path.join(outDir, `template.${values.env}.yaml`);
    fs.writeFileSync(outFile, yamlText);
    console.log(`Wrote ${outFile}`);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

main(process.argv.slice(2));
