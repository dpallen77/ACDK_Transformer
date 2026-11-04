# Project: JSON → CloudFormation generator (built on AWS CDK)

## Goal
Build a command-line tool that reads JSON files written against **our own schema** and
generates **CloudFormation templates in YAML**. Users never write CDK code; the CDK is
used internally as a library to do the heavy lifting (defaults, IAM wiring, validation).

Think of it as a small "Bicep for AWS", with JSON as the input language.

```
environments/*.json + resources/*.json  →  mytool (CDK inside)  →  template.<env>.yaml
```

## Background decisions (already agreed)
- CDK is the right engine: it fills in sensible defaults, IAM policies and related
  resources, so the JSON can stay short.
- The tool calls `app.synth()` **in-process**. It does **not** depend on the `cdk` CLI.
- Synthesis must work **without AWS credentials**. Do not use CDK lookup features
  (e.g. `Vpc.fromLookup`); take IDs/ARNs from environment files instead.
- CDK writes JSON by default; the tool converts the synthesized template to YAML
  (e.g. `js-yaml` `dump`).
- Not in scope: converting existing CloudFormation JSON to YAML (`cfn-flip` already does
  that) or CloudFormation → CDK code (`cdk migrate` already does that).

## Language and packaging
- Write the tool in **TypeScript** on Node (CDK is TypeScript-native).
- Ship as a single executable (`bun build --compile` or Node single-executable apps),
  with a Docker image as an alternative.

## Input layout
```
environments/
  common.json   # values shared by all environments
  dev.json      # environment-specific values, override common
  prod.json
resources/
  api.json
  data.json
```

### Environment files
Hold shared values once (account, region, VPC, certificate ARNs, secret names):

```json
{
  "account": "123456789012",
  "region": "us-west-2",
  "vpcId": "vpc-0abc123",
  "certificates": {
    "apiCert": "arn:aws:acm:us-west-2:123456789012:certificate/abcd-1234"
  },
  "secrets": {
    "dbPassword": "prod/db/password"
  }
}
```

### Resource files
Reference environment values with `${env.<path>}` placeholders instead of duplicating them:

```json
{
  "apis": [{
    "name": "orders-api",
    "domain": "api.example.com",
    "certificate": "${env.certificates.apiCert}",
    "secrets": ["${env.secrets.dbPassword}"],
    "vpc": "${env.vpcId}"
  }]
}
```

## Processing pipeline
Invocation: `mytool synth --env prod`

1. Load `environments/common.json`, deep-merge `environments/<env>.json` over it.
2. Load all resource files.
3. Substitute every `${env...}` placeholder; fail with a clear error on unknown paths.
4. Validate the resolved input against the published **JSON Schema**.
5. Map each entry to CDK constructs (`s3.Bucket`, `lambda.Function`, etc.).
6. Resolve cross-resource references (see below) and wire permissions.
7. `app.synth()`, take the stack template, write `template.<env>.yaml`.

Sketch:
```ts
const config = JSON.parse(fs.readFileSync('infra.json', 'utf8'));
const app = new cdk.App();
const stack = new cdk.Stack(app, config.stackName);

for (const b of config.buckets ?? []) {
  new s3.Bucket(stack, b.name, { versioned: b.versioned });
}

const template = app.synth().getStackByName(config.stackName).template;
fs.writeFileSync('template.yaml', yaml.dump(template));
```

## Design rules
- **Secrets never appear in JSON or generated YAML.** Environment files store only a
  Secrets Manager / SSM Parameter Store name or an ACM certificate ARN. CDK emits dynamic
  references (e.g. `{{resolve:secretsmanager:prod/db/password}}`) that CloudFormation
  resolves at deploy time. (AWS equivalents of Azure Key Vault: Secrets Manager / SSM;
  certificates: ACM.)
- **Values are baked in per environment** (one template per env). CloudFormation
  Parameters were considered and set aside for now as harder to read and less compatible
  with CDK helpers.
- **Shared definitions:** secrets, certificates and similar can be declared once under a
  logical name (e.g. `"dbPassword"`) and referenced by name from resources.
- **Cross-resource references** use logical names, e.g. `"readsFrom": "logs-bucket"`;
  the mapping layer turns these into grants (`bucket.grantRead(fn)`), so users never
  write IAM by hand.
- **Escape hatch:** an optional raw-properties field passes properties straight through
  to the underlying CloudFormation resource for anything the schema doesn't cover.
- **Publish a real JSON Schema file** for validation errors and editor autocomplete.
- **Stay opinionated:** model a handful of high-level types matching our common patterns
  ("standard API", "standard data bucket"). Do not try to mirror every AWS resource —
  that recreates CloudFormation with extra steps.

## Open decisions
- **Assets:** Lambda code or Docker images make CDK emit asset files that need uploading
  (normally via `cdk bootstrap` / `cdk deploy`). Decide whether the tool handles
  publishing, or v1 is limited to template-only resources (e.g. inline code, prebuilt
  images referenced by URI).
- Exact placeholder syntax and escaping rules.
- Which 2–3 resource types to implement first.
- Deployment: does the tool also deploy, or only emit templates?

## Suggested first milestone
1. JSON Schema covering environment files and 2–3 resource types.
2. Loader: merge environments, resolve placeholders, validate.
3. Mapping layer for those resource types, including one cross-resource grant.
4. `synth --env <name>` writing YAML; snapshot tests of generated templates.
