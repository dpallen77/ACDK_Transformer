import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as yaml from "js-yaml";
import type { Construct } from "constructs";

/** Settings from environments/common.json + environments/<env>.json that the tool itself reads. */
export interface EnvironmentConfig {
  stackName: string;
  account?: string;
  region?: string;
  /** Applied to every resource in the stack. */
  tags?: Record<string, string>;
}

export interface BucketConfig {
  name: string;
  versioned?: boolean;
}

/**
 * A containerised web app: the AWS counterpart of an Azure App Service.
 * Backed by ECS Express Mode, which creates the load balancer, HTTPS URL
 * and autoscaling itself. With no network settings it uses the default VPC.
 */
export interface WebAppConfig {
  name: string;
  /** A prebuilt container image URI (no local build/upload in v1). */
  image: string;
  port?: number;
  /** vCPU units as ECS expects them, e.g. "256" = 0.25 vCPU. */
  cpu?: string;
  /** Memory in MiB, e.g. "512". */
  memory?: string;
  healthCheckPath?: string;
  environment?: Record<string, string>;
}

export interface ResourcesConfig {
  buckets?: BucketConfig[];
  webApps?: WebAppConfig[];
}

function addWebApp(scope: Construct, app: WebAppConfig): void {
  // The tool writes the IAM so users don't have to.
  const executionRole = new iam.Role(scope, `${app.name}-execution-role`, {
    assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    managedPolicies: [
      iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy"),
    ],
  });
  const infrastructureRole = new iam.Role(scope, `${app.name}-infrastructure-role`, {
    assumedBy: new iam.ServicePrincipal("ecs.amazonaws.com"),
    managedPolicies: [
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        "service-role/AmazonECSInfrastructureRoleforExpressGatewayServices",
      ),
    ],
  });

  new ecs.CfnExpressGatewayService(scope, app.name, {
    serviceName: app.name,
    executionRoleArn: executionRole.roleArn,
    infrastructureRoleArn: infrastructureRole.roleArn,
    cpu: app.cpu ?? "256",
    memory: app.memory ?? "512",
    healthCheckPath: app.healthCheckPath ?? "/",
    primaryContainer: {
      image: app.image,
      containerPort: app.port ?? 80,
      environment: Object.entries(app.environment ?? {}).map(([name, value]) => ({ name, value })),
    },
  });
}

/** Build the CDK stack in-process and return the CloudFormation template as YAML. */
export function synthesize(env: EnvironmentConfig, resources: ResourcesConfig): string {
  // A throwaway output dir keeps CDK from writing cdk.out into the project.
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "acdk-"));
  try {
    const app = new cdk.App({ outdir });
    const stack = new cdk.Stack(app, env.stackName, {
      // Explicit account/region; no lookups, so no AWS credentials needed.
      env: env.account || env.region ? { account: env.account, region: env.region } : undefined,
      // Skip the CDK bootstrap version parameter/rule: we only want a plain template.
      synthesizer: new cdk.DefaultStackSynthesizer({ generateBootstrapVersionRule: false }),
    });

    for (const [key, value] of Object.entries(env.tags ?? {})) {
      cdk.Tags.of(stack).add(key, value);
    }
    for (const b of resources.buckets ?? []) {
      new s3.Bucket(stack, b.name, { versioned: b.versioned ?? false });
    }
    for (const w of resources.webApps ?? []) {
      addWebApp(stack, w);
    }

    const template = app.synth().getStackByName(env.stackName).template;
    return yaml.dump(template, { noRefs: true, lineWidth: -1 });
  } finally {
    fs.rmSync(outdir, { recursive: true, force: true });
  }
}
