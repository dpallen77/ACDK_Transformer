# ACDK Transformer

Turns short JSON files into CloudFormation templates (YAML), one per environment.
AWS CDK does the work internally; you never write CDK code. See [CLAUDE.md](CLAUDE.md)
for the design background.

## Prerequisites

- Node.js 22 or later
- `npm install` once in the repo root

No AWS credentials are needed to generate templates.

## Generate templates for the demo

```sh
npm run synth -- --env dev  --dir examples/demo
npm run synth -- --env prod --dir examples/demo
```

This writes `examples/demo/template.dev.yaml` and `examples/demo/template.prod.yaml`.

Options:

| Option         | Meaning                                                  |
| -------------- | -------------------------------------------------------- |
| `--env <name>` | Required. Uses `environments/<name>.json`.               |
| `--dir <path>` | The project folder to read. Default: current directory.  |
| `--out <path>` | Where to write the template. Default: the project folder. |

## Add your own project

1. Create a folder with this layout, e.g. `examples/my-app/`:

   ```
   examples/my-app/
     environments/
       common.json   # shared by every environment (optional)
       dev.json      # one file per environment
     resources/
       web.json      # any number of resource files
   ```

2. Put shared settings in `environments/common.json`. `stackName` is required
   (here or in the environment file):

   ```json
   {
     "stackName": "my-app",
     "region": "us-west-2",
     "tags": { "project": "my-app" },
     "webApp": { "image": "public.ecr.aws/nginx/nginx:latest", "cpu": "256", "memory": "512" }
   }
   ```

3. Put environment-specific values in `environments/dev.json`. They are merged over
   `common.json`: nested objects merge key by key, other values replace.

   ```json
   { "account": "111111111111", "tags": { "environment": "dev" } }
   ```

4. Describe resources in `resources/*.json`. Use `${env.<path>}` to pull in
   environment values:

   ```json
   {
     "webApps": [
       {
         "name": "my-web",
         "image": "${env.webApp.image}",
         "cpu": "${env.webApp.cpu}",
         "memory": "${env.webApp.memory}",
         "environment": { "APP_ENV": "${env.tags.environment}" }
       }
     ]
   }
   ```

5. Generate:

   ```sh
   npm run synth -- --env dev --dir examples/my-app
   ```

## Settings the tool reads from environment files

| Key         | Required | Meaning                                         |
| ----------- | -------- | ----------------------------------------------- |
| `stackName` | yes      | Name of the CloudFormation stack                |
| `account`   | no       | AWS account ID for the stack                    |
| `region`    | no       | AWS region for the stack                        |
| `tags`      | no       | Tags added to every resource                    |

Any other keys are yours to define and reference with `${env.<path>}`.

## Resource types

**`buckets`**: S3 buckets.

| Field       | Required | Default |
| ----------- | -------- | ------- |
| `name`      | yes      |         |
| `versioned` | no       | `false` |

**`webApps`**: containerised web apps on ECS Express Mode (the AWS counterpart of an
Azure App Service). Uses the account's default VPC. The tool creates the IAM roles.

| Field             | Required | Default | Notes                                   |
| ----------------- | -------- | ------- | --------------------------------------- |
| `name`            | yes      |         |                                         |
| `image`           | yes      |         | An existing image URI (ECR, Docker Hub) |
| `port`            | no       | `80`    |                                         |
| `cpu`             | no       | `"256"` | vCPU units: `"256"` = 0.25 vCPU         |
| `memory`          | no       | `"512"` | MiB                                     |
| `healthCheckPath` | no       | `"/"`   |                                         |
| `environment`     | no       |         | Map of environment variables            |

## Placeholders

- `"${env.webApp.port}"` on its own keeps the value's type (here, a number).
- `"https://${env.domain}/api"` inserts the value into the text.
- An unknown path stops the run and says where it is, e.g.
  `Unknown placeholder ${env.webApp.cpuu} at resources.webApps[0].cpu`.

## Validation

Every file is checked against the JSON Schemas in [schemas/](schemas/):

- [environment.schema.json](schemas/environment.schema.json) for `environments/*.json`
- [resources.schema.json](schemas/resources.schema.json) for `resources/*.json`

Misspelt fields, missing required fields and wrong types stop the run with every
problem listed:

```
Error: resources/web.json is not valid:
  /webApps/0: unknown field "memmory"
  /webApps/0/port: must be integer (or an ${env.…} placeholder)
```

Resource files are checked twice: once as written (any field may be a placeholder),
and again after placeholders are filled in, so a bad value in an environment file
(e.g. `"cpu": "300"`) is caught too. Environment files may contain extra keys of your
own; resource files may not.

**In VS Code** this repo's [.vscode/settings.json](.vscode/settings.json) applies the
schemas automatically, giving autocomplete and red underlines as you type. Outside
this repo, add a `"$schema"` key pointing at the schema file, e.g.
`"$schema": "../../../schemas/resources.schema.json"`.

## Development

```sh
npm test           # run the tests
npm run typecheck  # type-check without building
```
