import type {
  DescribeChangeSetOutput,
  StackEvent,
  StackResource,
} from "@aws-sdk/client-cloudformation";
import chalk from "chalk";
import logSymbols from "log-symbols";
import stringLength from "string-length";
import { Tty } from "../internal/tty.js";
import { Spinner } from "./spinner.js";

// there isn't yet a AWS::CloudFormation::* id for this
const ChangeSetResourceType = "ChangeSet";
const MaxStatusLength = 30;

export class StackReporter {
  private readonly resources = new Map<string, StackEvent>();
  private readonly ownTty: boolean;
  private readonly spinner: Spinner;
  private readonly tty: Tty;

  private completeCount = 0;
  private maxLogicalIdLength = 0;
  private stackName = "";

  public logChangeSetEvents = true;

  constructor(tty?: Tty) {
    this.ownTty = !tty;
    this.tty = tty ?? new Tty();
    this.spinner = new Spinner(this.render, this.tty.isEnabled);
  }

  public close(): void {
    this.spinner.isEnabled = false;
    this.resources.clear();

    if (this.ownTty) {
      this.tty.done(true);
    }
  }

  public init(changeset: DescribeChangeSetOutput): void {
    if (changeset.StackName) {
      this.stackName = changeset.StackName;
    }
    if (changeset.StackName) {
      this.onProgress({
        EventId: changeset.StackId!,
        LogicalResourceId: changeset.ChangeSetName,
        PhysicalResourceId: changeset.ChangeSetId,
        ResourceStatus: changeset.Status as any,
        ResourceStatusReason: changeset.StatusReason,
        ResourceType: ChangeSetResourceType,
        StackId: changeset.StackId,
        StackName: changeset.StackName,
        Timestamp: changeset.CreationTime!,
      });
    }
    if (!changeset.Changes) {
      return;
    }

    // get the longest id for padding purposes
    this.maxLogicalIdLength = changeset.Changes.reduce(
      (a, x) => Math.max(a, x.ResourceChange?.LogicalResourceId?.length ?? 0),
      Math.max(this.maxLogicalIdLength, changeset.StackName?.length ?? 0),
    );

    for (const change of changeset.Changes) {
      if (!change.ResourceChange?.LogicalResourceId) {
        continue;
      }
      let status: string | undefined;
      if (change.ResourceChange.Action === "Add") {
        status = "CREATE_PENDING";
      } else if (change.ResourceChange.Action === "Remove") {
        status = "DELETE_PENDING";
      } else if (change.ResourceChange.Action) {
        status = `${change.ResourceChange.Action.toUpperCase()}_PENDING`;
      }

      this.onProgress({
        EventId: changeset.StackId!,
        LogicalResourceId: change.ResourceChange.LogicalResourceId,
        PhysicalResourceId: change.ResourceChange.PhysicalResourceId,
        ResourceStatus: status as any,
        ResourceType: change.ResourceChange.PhysicalResourceId,
        StackId: changeset.StackId,
        StackName: changeset.StackName,
        Timestamp: changeset.CreationTime!,
      });
    }
  }

  public initDelete(resources: StackResource[]): void {
    this.stackName = resources.find((x) => x.StackName)?.StackName as string;

    // get the longest id for padding purposes
    this.maxLogicalIdLength = resources.reduce(
      (a, x) => Math.max(a, x.LogicalResourceId?.length ?? 0),
      Math.max(this.maxLogicalIdLength, this.stackName?.length ?? 0),
    );

    for (const resource of resources) {
      this.onProgress({
        ...resource,
        ResourceStatus: "DELETE_PENDING" as any,
      } as StackEvent);
    }
  }

  public onProgress(event: StackEvent): void {
    if (!this.stackName && event.StackName) {
      this.stackName = event.StackName;
    }
    if (!event.LogicalResourceId) {
      return;
    }

    const lastStatus = this.resources.get(
      event.LogicalResourceId,
    )?.ResourceStatus;

    if (event.ResourceType !== ChangeSetResourceType) {
      this.resources.set(event.LogicalResourceId, event);
    }

    const inProgress = event.ResourceStatus?.endsWith("_IN_PROGRESS");
    const pending = event.ResourceStatus?.endsWith("_PENDING");
    const stackStatus = this.resources.get(this.stackName)?.ResourceStatus;
    const rollback = stackStatus?.includes("_ROLLBACK_");
    const changeset = event.ResourceType === ChangeSetResourceType;
    const isStack = event.StackId === event.PhysicalResourceId;

    if (
      (!inProgress || isStack) &&
      !pending &&
      lastStatus !== event.ResourceStatus &&
      (!changeset || this.logChangeSetEvents)
    ) {
      let icon: string;
      let complete = false;
      if (event.ResourceStatus?.endsWith("_SKIPPED")) {
        complete = true;
        icon = chalk.magenta(`↓`);
      } else if (event.ResourceStatus?.endsWith("_FAILED")) {
        icon = logSymbols.error;
      } else if (event.ResourceStatus?.includes("_ROLLBACK_")) {
        icon = logSymbols.error;
      } else if (event.ResourceStatus?.endsWith("_COMPLETE")) {
        complete = !changeset;
        icon = logSymbols.success;
      } else {
        icon = logSymbols.info;
      }

      const text = this.getStatusText(event);
      this.tty.interrupt(`${icon} ${text}`);

      if (complete) {
        if (rollback) {
          --this.completeCount;
        } else {
          ++this.completeCount;
        }
      }
    }
  }

  private readonly render = (): void => {
    if (!this.resources.size) {
      return;
    }
    const lines: string[] = [];

    const allResources = [...this.resources.values()].filter(
      (x) => x.PhysicalResourceId !== x.StackId,
    );

    // sort the in-progress resources to the end, in case there's too many to
    // show in the TTY
    const pending = allResources.filter((x) =>
      x.ResourceStatus?.endsWith("_PENDING"),
    );
    const inProgress = allResources.filter((x) =>
      x.ResourceStatus?.endsWith("_IN_PROGRESS"),
    );

    for (const resource of pending) {
      lines.push(this.getStatusText(resource, true));
    }
    for (const resource of inProgress) {
      lines.push(this.getStatusText(resource, true));
    }

    const stackEvent = this.resources.get(this.stackName);
    const statusColor = getStatusColor(stackEvent?.ResourceStatus ?? "");

    if (stackEvent) {
      const rollback = stackEvent?.ResourceStatus?.includes("_ROLLBACK_");
      const progressColor = rollback ? chalk.red : (x: string) => x;
      const completeCount = this.completeCount.toString().padStart(3);
      const totalCount = this.resources.size.toString().padEnd(3);

      const status = [
        chalk.whiteBright(this.stackName),
        statusColor(stackEvent?.ResourceStatus ?? ""),
        `${completeCount} / ${totalCount}`,
      ];

      let statusText = ":::: " + status.map((x) => ` ${x} `).join(" ");

      const progress = progressBar(
        this.completeCount / this.resources.size,
        this.tty.windowWidth - stringLength(statusText) - 6,
      );

      statusText += ` ${progressColor(progress)} ::::`;

      lines.push("");
      lines.push(statusText);
    }

    this.tty.display(this, lines.join(`\n`));
  };

  private getStatusText(event: StackEvent, includeSpinner = false): string {
    const statusColor = getStatusColor(event.ResourceStatus);
    const failed = event.ResourceStatus?.endsWith("_FAILED");
    const rollback = event.ResourceStatus?.includes("_ROLLBACK_");

    let props: string | undefined;
    if (event.ResourceProperties && (rollback || failed)) {
      props = JSON.stringify(JSON.parse(event.ResourceProperties), null, 2)
        .split("\n")
        .map((x) => `    ${x}`)
        .join(`\n`);
    }

    let reason: string | undefined;
    if (event.ResourceStatusReason) {
      if (failed) {
        reason = chalk.red(`\n    ${event.ResourceStatusReason}`);
      } else {
        reason = chalk.gray(`\n    ${event.ResourceStatusReason}`);
      }
    }

    const parts = [
      event.LogicalResourceId?.padEnd(this.maxLogicalIdLength),
      statusColor(event.ResourceStatus?.padEnd(MaxStatusLength)),
      event.ResourceType && chalk.cyan(event.ResourceType),
      reason,
      event.PhysicalResourceId &&
        chalk.gray(`\n    ${event.PhysicalResourceId}`),
      props && chalk.gray("\n" + props),
    ];

    const text = parts.filter(Boolean).join(" ");

    if (includeSpinner) {
      return `${statusColor(this.spinner.frame)} ${text}`;
    } else {
      return text;
    }
  }
}

function getStatusColor(status: string | undefined): (x?: string) => string {
  if (!status) {
    return (x) => x ?? "";
  }

  const complete = status.endsWith("_COMPLETE");
  const failed = status.endsWith("_FAILED");
  const rollback = status.includes("_ROLLBACK_");
  const skipped = status.endsWith("_SKIPPED");

  if (failed || rollback) {
    return chalk.red;
  } else if (complete) {
    return chalk.green;
  } else if (skipped) {
    return chalk.magenta;
  }

  return chalk.yellow;
}

function progressBar(value: number, width: number): string {
  const progress = Number.isNaN(value) ? 0 : Math.floor(value * width);
  const rest = width - progress;
  return "".padEnd(progress, "█") + "".padEnd(rest, "░");
}
