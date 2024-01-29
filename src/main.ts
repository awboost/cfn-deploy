#!/usr/bin/env node
import { Command, Option } from "commander";
import {
  createChangeSet,
  deleteStack,
  executeChangeSet,
  upload,
  type CreateChangeSetOptions,
  type DeleteStackOptions,
  type UploadOptions,
} from "./commands.js";
import { installConfigHooks } from "./internal/install-config-hooks.js";

const ProgramName = "cfn-deploy";
const program = new Command();

program
  .name(ProgramName)
  .description(
    "Create, update and delete CloudFormation stacks with streaming logs.",
  )
  .configureHelp({ showGlobalOptions: true })
  .addOption(
    new Option("--access-key-id <value>", "the AWS access key ID").env(
      "AWS_ACCESS_KEY_ID",
    ),
  )
  .addOption(
    new Option("--secret-access-key <value>", "the AWS secret access key").env(
      "AWS_SECRET_ACCESS_KEY",
    ),
  )
  .addOption(
    new Option("--session-token <value>", "the AWS session token").env(
      "AWS_SESSION_TOKEN",
    ),
  )
  .addOption(new Option("--region <value>", "the AWS region").env("AWS_REGION"))
  .option("--config <path>", "path to the config file", `.${ProgramName}.json`)
  .option("--no-config", "skip trying to load a config file")
  .addOption(
    new Option("-p, --profile <name>", "the profile to use with aws-vault").env(
      "AWS_VAULT",
    ),
  );

program
  .command("upload")
  .description("upload a template and associated assets to S3")
  .argument("<template>", "path to the template file")
  .option(`-b, --bucket <value>`, "the S3 bucket name to upload to")
  .action(async (templatePath: string, _, cmd: Command) => {
    const options = cmd.optsWithGlobals<UploadOptions>();
    await upload(templatePath, options);
  });

program
  .command("changeset")
  .description("create a changeset and optionally execute it")
  .argument("<template>", "URL to the template file")
  .option("-b, --bucket <value>", "the S3 bucket name to upload to")
  .option("--changeset-name <value>", "an optional name for the changeset")
  .option("--create", "create the stack with this changeset")
  .option("--no-execute", "don't execute the changeset, just upload it")
  .requiredOption("--stack-name <value>", "the name of the stack")
  .action(async (templateUrl: string, _, cmd: Command) => {
    const options = cmd.optsWithGlobals<CreateChangeSetOptions>();
    const changeset = await createChangeSet(templateUrl, options);

    if (changeset.Status === "FAILED") {
      process.exit(1);
    }

    const result = await executeChangeSet(changeset.ChangeSetId!, options, {
      changeset,
    });

    if (!result) {
      process.exit(1);
    }
  });

program
  .command("delete")
  .description("delete a stack and all of its resources")
  .argument("<stackNameOrId>", "the name or ID (ARN) of the stack to delete")
  .action(async (stackNameOrId: string, _, cmd: Command) => {
    const options = cmd.optsWithGlobals<DeleteStackOptions>();
    await deleteStack(stackNameOrId, options);
  });

installConfigHooks(program);
await program.parseAsync();
