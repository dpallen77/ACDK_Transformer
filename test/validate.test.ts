import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadEnvironment, loadResources, planRegions } from "../src/config.js";
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
  "environments/common.json": { stackName: "test-app", region: "us-west-2", webApp: { cpu: "256", port: 8080 } },
  "environments/dev.json": { account: "111111111111" },
};

/** What `synth` does before CDK: load, plan per region, validate. Returns { region: resources }. */
function loadAll(dir: string, env = "dev") {
  const plan = planRegions(loadEnvironment(dir, env), loadResources(dir));
  for (const resources of plan.values()) validate("resources", resources, "resolved");
  return Object.fromEntries(plan);
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
  assert.deepEqual(loadAll(dir), {
    "us-west-2": { webApps: [{ name: "web", image: "nginx", port: 8080, cpu: "256" }] },
  });
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

test("region is required after merging", () => {
  const dir = project({ "environments/dev.json": { stackName: "x" } });
  assert.throws(() => loadEnvironment(dir, "dev"), /"region" must be set/);
});

test("duplicate names are reported with both files", () => {
  const dir = project({
    ...baseEnv,
    "resources/a.json": { buckets: [{ name: "shared" }] },
    "resources/b.json": { webApps: [{ name: "shared", image: "nginx" }] },
  });
  assert.throws(() => loadAll(dir), /"shared" is used in both resources\/a\.json and resources\/b\.json/);
});

test("duplicate names in one file are reported", () => {
  const dir = project({ ...baseEnv, "resources/a.json": { buckets: [{ name: "x" }, { name: "x" }] } });
  assert.throws(() => loadAll(dir), /"x" is used twice in resources\/a\.json/);
});

test("a resource with regions goes to each region; others stay in the default region", () => {
  const dir = project({
    ...baseEnv,
    "resources/a.json": {
      buckets: [{ name: "logs" }],
      webApps: [{ name: "web", image: "nginx", regions: ["us-west-2", "eu-west-1"] }],
    },
  });
  const plan = loadAll(dir);
  assert.deepEqual(Object.keys(plan), ["us-west-2", "eu-west-1"]);
  assert.deepEqual(plan["us-west-2"], { buckets: [{ name: "logs" }], webApps: [{ name: "web", image: "nginx" }] });
  assert.deepEqual(plan["eu-west-1"], { webApps: [{ name: "web", image: "nginx" }] });
});

test("regions can come from the environment, with per-region overrides and ${env.region}", () => {
  const dir = project({
    ...baseEnv,
    "environments/dev.json": {
      webRegions: ["us-west-2", "eu-west-1"],
      image: "us-image",
      regionOverrides: { "eu-west-1": { image: "eu-image" } },
    },
    "resources/a.json": {
      webApps: [
        {
          name: "web",
          regions: "${env.webRegions}",
          image: "${env.image}",
          environment: { REGION: "${env.region}" },
        },
      ],
    },
  });
  const plan = loadAll(dir);
  assert.deepEqual(plan["us-west-2"], {
    webApps: [{ name: "web", image: "us-image", environment: { REGION: "us-west-2" } }],
  });
  assert.deepEqual(plan["eu-west-1"], {
    webApps: [{ name: "web", image: "eu-image", environment: { REGION: "eu-west-1" } }],
  });
});

test("a misspelt region is rejected", () => {
  const dir = project({ ...baseEnv, "resources/a.json": { buckets: [{ name: "b", regions: ["us-west2"] }] } });
  assert.throws(() => loadAll(dir), /\/buckets\/0\/regions/);
});

test("regionOverrides may not change region", () => {
  const dir = project({ ...baseEnv, "environments/dev.json": { regionOverrides: { "eu-west-1": { region: "x" } } } });
  assert.throws(() => loadEnvironment(dir, "dev"), /environments\/dev\.json is not valid/);
});
