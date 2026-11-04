import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadEnvironment, loadResources, resolvePlaceholders } from "../src/config.js";
import { validate } from "../src/validate.js";

const demoDir = path.join(import.meta.dirname, "..", "examples", "demo");

/** Write a throwaway project: { "environments/dev.json": {...}, ... }. */
function project(files: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acdk-test-"));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), JSON.stringify(content));
  }
  return dir;
}

const baseEnv = {
  "environments/common.json": { stackName: "test-app", webApp: { cpu: "256", port: 8080 } },
  "environments/dev.json": { account: "111111111111" },
};

function loadAll(dir: string, env = "dev") {
  const environment = loadEnvironment(dir, env);
  const resources = resolvePlaceholders(loadResources(dir), environment);
  validate("resources", resources, "resolved");
  return resources;
}

test("the demo project is valid for every environment", () => {
  for (const env of ["dev", "prod"]) assert.doesNotThrow(() => loadAll(demoDir, env));
});

test("placeholders are accepted where a number or enum is expected", () => {
  const dir = project({
    ...baseEnv,
    "resources/web.json": {
      webApps: [{ name: "web", image: "nginx", port: "${env.webApp.port}", cpu: "${env.webApp.cpu}" }],
    },
  });
  assert.deepEqual(loadAll(dir), { webApps: [{ name: "web", image: "nginx", port: 8080, cpu: "256" }] });
});

test("a misspelt field names the file and the field", () => {
  const dir = project({
    ...baseEnv,
    "resources/web.json": { webApps: [{ name: "web", image: "nginx", memmory: "512" }] },
  });
  assert.throws(() => loadAll(dir), /resources\/web\.json is not valid:\n {2}\/webApps\/0: unknown field "memmory"/);
});

test("a misspelt resource type is rejected", () => {
  const dir = project({ ...baseEnv, "resources/web.json": { webapps: [] } });
  assert.throws(() => loadAll(dir), /unknown field "webapps"/);
});

test("a missing required field is reported", () => {
  const dir = project({ ...baseEnv, "resources/web.json": { webApps: [{ name: "web" }] } });
  assert.throws(() => loadAll(dir), /\/webApps\/0: missing required field "image"/);
});

test("a bad value coming from an environment file is caught after substitution", () => {
  const dir = project({
    ...baseEnv,
    "environments/dev.json": { webApp: { cpu: "300" } },
    "resources/web.json": { webApps: [{ name: "web", image: "nginx", cpu: "${env.webApp.cpu}" }] },
  });
  assert.throws(() => loadAll(dir), /resolved is not valid:\n {2}\/webApps\/0\/cpu: must be one of 256, 512/);
});

test("environment files are checked individually", () => {
  const dir = project({ ...baseEnv, "environments/dev.json": { account: "1234" } });
  assert.throws(() => loadEnvironment(dir, "dev"), /environments\/dev\.json is not valid:\n {2}\/account: must match/);
});

test("stackName is required after merging", () => {
  const dir = project({ "environments/dev.json": { region: "us-west-2" } });
  assert.throws(() => loadEnvironment(dir, "dev"), /"stackName" must be set/);
});
