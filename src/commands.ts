import type { Template } from "@awboost/cfn-template-builder/template";
import {
  AssetBucketNameParameter,
  AssetMap,
} from "@awboost/cfn-template-builder/template/asset";
import {
  CloudFormationClient,
  CreateChangeSetCommand,
  DeleteStackCommand,
  DescribeChangeSetCommand,
  DescribeStackResourcesCommand,
  ExecuteChangeSetCommand,
  paginateDescribeStacks,
  type DescribeChangeSetOutput,
  type Parameter,
  type Stack,
} from "@aws-sdk/client-cloudformation";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { AwsCredentialIdentity, Provider } from "@aws-sdk/types";
import chalk from "chalk";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  getCredentials,
  type CredentialOptions,
} from "./internal/credentials.js";
import { readToEnd } from "./internal/read-to-end.js";
import { streamChangeSetEvents } from "./internal/stream-stack-events.js";
import { AssetReporter } from "./reporters/asset-reporter.js";
import { StackReporter } from "./reporters/stack-reporter.js";
import { S3AssetEmitter } from "./util/s3-asset-emitter.js";

export type BaseOptions = CredentialOptions & {
  region?: string;
};

export type UploadOptions = {
  bucket: string;
} & BaseOptions;

export type ParameterProvider = (
  stack: Stack | undefined,
) => Parameter[] | PromiseLike<Parameter[]>;

export type CreateChangeSetOptions = {
  bucket?: string;
  create?: boolean;
  changesetName?: string;
  noExecute?: boolean;
  parameterFile?: string;
  parameters?: Record<string, string> | ParameterProvider;
  stackName: string;
} & BaseOptions;

export type DeleteStackOptions = BaseOptions;
export type ExecuteChangeSetOptions = BaseOptions;

export async function upload(
  templatePath: string,
  options: UploadOptions,
  services?: {
    credentials?: AwsCredentialIdentity | Provider<AwsCredentialIdentity>;
    s3?: S3Client;
  },
): Promise<void> {
  if (!templatePath) {
    throw new Error(`expected template path`);
  }
  if (!options.bucket) {
    throw new Error(`expected bucket`);
  }
  const emitter = new S3AssetEmitter({
    bucket: options.bucket,
    s3: services?.s3,
    s3Config: {
      credentials: services?.credentials ?? getCredentials(options),
      region: options.region,
    },
  });

  console.log(`\nUploading assets:`);
  const status = new AssetReporter();
  emitter.on("progress", (e) => status.onProgress(e));

  const templateText = await readFile(templatePath, "utf-8");
  const template: Template = JSON.parse(templateText);

  emitter.addAsset({
    fileName: basename(templatePath),
    createReadStream: () => Readable.from(templateText),
  });

  const assetMap = template.Mappings?.[AssetMap.FirstLevelKey];
  if (assetMap) {
    for (const asset of Object.values(assetMap)) {
      emitter.addAsset({
        fileName: asset["FileName"],
        createReadStream: () =>
          createReadStream(join(dirname(templatePath), asset["FileName"])),
      });
    }
  }

  await emitter.done();
}

export async function createChangeSet(
  templateUrl: string,
  options: CreateChangeSetOptions,
): Promise<DescribeChangeSetOutput> {
  const credentials = getCredentials(options);
  const s3 = new S3Client({ credentials, region: options.region });
  const url = new URL(templateUrl);

  let templateKey: string;
  let bucket = options.bucket;
  let template: Template;

  if (url.protocol === "file:") {
    if (!bucket) {
      throw new Error(`can't specify file URL without specifying bucket`);
    }
    const templatePath = fileURLToPath(templateUrl);
    template = JSON.parse(await readFile(templatePath, "utf8"));
    await upload(templatePath, { ...options, bucket }, { s3 });
    templateKey = basename(templatePath);
  } else if (url.protocol === "s3:") {
    // trim '/' from start
    templateKey = url.pathname.slice(1);
    bucket = url.hostname;

    const result = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: templateKey }),
    );
    template = JSON.parse(
      (await readToEnd(result.Body as Readable)).toString("utf-8"),
    );
  } else {
    throw new Error(`unexpected template URL protocol "${url.protocol}"`);
  }

  console.log(`\nCreating changeset:`);

  const cfn = new CloudFormationClient({
    credentials,
    region: options.region,
  });

  const clientToken = randomUUID();
  const timestamp = new Date().toISOString().replace(/[T:.]/g, "-");
  const changeSetName = options.changesetName ?? `Change-${timestamp}`;

  const parameters: Parameter[] = [];

  // add the name of the bucket as a parameter if required
  if (template.Parameters?.[AssetBucketNameParameter.ParameterName]) {
    parameters.push({
      ParameterKey: AssetBucketNameParameter.ParameterName,
      ParameterValue: bucket,
    });
  }

  if (typeof options.parameters === "function") {
    let stack: Stack | undefined;

    if (!options.create) {
      stack = await getStack(cfn, options.stackName);
    }
    const params = await options.parameters(stack);
    parameters.push(...params);
  } else if (options.parameters) {
    parameters.push(
      ...Object.entries(options.parameters).map(
        ([key, value]): Parameter => ({
          ParameterKey: key,
          ParameterValue: value,
        }),
      ),
    );
  }

  const usedResourceTypes = new Set(
    Object.values(template.Resources).map((x) => x.Type),
  );

  const createResult = await cfn.send(
    new CreateChangeSetCommand({
      ChangeSetName: changeSetName,
      ChangeSetType: options.create ? "CREATE" : "UPDATE",
      ClientToken: clientToken,
      OnStackFailure: options.create ? "DELETE" : "ROLLBACK",
      Parameters: parameters,
      ResourceTypes: [...usedResourceTypes],
      StackName: options.stackName,
      TemplateURL: `https://${bucket}.s3.amazonaws.com/${templateKey}`,
    }),
  );

  const reporter = new StackReporter();
  try {
    return await waitForChangeset(createResult.Id!, cfn, reporter);
  } finally {
    reporter.close();
  }
}

export async function executeChangeSet(
  idOrName: string,
  options: ExecuteChangeSetOptions,
  services?: {
    cfn?: CloudFormationClient;
    changeset?: DescribeChangeSetOutput;
  },
): Promise<boolean> {
  const cfn =
    services?.cfn ??
    new CloudFormationClient({
      credentials: getCredentials(options),
      region: options.region,
    });

  console.log(`\nExecuting changeset:`);
  const reporter = new StackReporter();
  // don't repeat the changeset events
  reporter.logChangeSetEvents = false;

  try {
    let changeset: DescribeChangeSetOutput;
    if (services?.changeset) {
      changeset = services?.changeset;
    } else {
      changeset = await waitForChangeset(idOrName, cfn, reporter);
    }

    reporter.init(changeset);
    if (changeset.Status === "FAILED") {
      return false;
    }

    const token = randomUUID();

    await cfn.send(
      new ExecuteChangeSetCommand({
        ChangeSetName: changeset.ChangeSetId,
        ClientRequestToken: token,
        StackName: changeset.StackId,
      }),
    );

    const events = streamChangeSetEvents(cfn, changeset.StackId!, token);

    for await (const event of events) {
      reporter.onProgress(event);

      if (event.PhysicalResourceId === changeset.StackId) {
        if (event.ResourceStatus?.endsWith("_COMPLETE")) {
          return true;
        }
        if (event.ResourceStatus?.endsWith("FAILED")) {
          return false;
        }
      }
    }

    // not sure how we'd get here
    return true;
  } finally {
    reporter.close();
  }
}

export async function deleteStack(
  stackNameOrId: string,
  options: DeleteStackOptions,
): Promise<boolean> {
  const credentials = getCredentials(options);
  const cfn = new CloudFormationClient({ credentials, region: options.region });
  const reporter = new StackReporter();

  const stack = await getStack(cfn, stackNameOrId);
  if (!stack) {
    console.log(`Stack ${stackNameOrId} not found`);
    return false;
  }

  const stackId = stack.StackId!;
  console.log(
    `Deleting stack ${stack.StackName} ${chalk.gray(`(${stackId})`)}`,
  );

  const resources = await cfn.send(
    new DescribeStackResourcesCommand({
      StackName: stackNameOrId,
    }),
  );

  const token = randomUUID();
  reporter.initDelete(resources.StackResources!);

  await cfn.send(
    new DeleteStackCommand({
      StackName: stackNameOrId,
      ClientRequestToken: token,
    }),
  );

  const events = streamChangeSetEvents(cfn, stackId, token);

  try {
    for await (const event of events) {
      reporter.onProgress(event);

      if (event.PhysicalResourceId === stackId) {
        if (event.ResourceStatus?.endsWith("_COMPLETE")) {
          return true;
        }
        if (event.ResourceStatus?.endsWith("FAILED")) {
          return false;
        }
      }
    }

    return true;
  } finally {
    reporter.close();
  }
}

async function waitForChangeset(
  id: string,
  cfn: CloudFormationClient,
  reporter: StackReporter,
): Promise<DescribeChangeSetOutput> {
  for (;;) {
    const result = await cfn.send(
      new DescribeChangeSetCommand({
        ChangeSetName: id,
      }),
    );
    reporter.init(result);

    if (result.Status === "FAILED" || result.Status?.endsWith("_COMPLETE")) {
      return result;
    }
    await delay(2000);
  }
}

async function getStack(
  client: CloudFormationClient,
  stackNameOrId: string,
): Promise<Stack | undefined> {
  const stackPages = paginateDescribeStacks(
    { client },
    { StackName: stackNameOrId },
  );

  for await (const page of stackPages) {
    if (!page.Stacks) {
      return;
    }
    for (const stack of page.Stacks) {
      if (stack.StackStatus !== "DELETE_COMPLETE") {
        return stack;
      }
    }
  }
}
