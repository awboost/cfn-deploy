import logSymbols from "log-symbols";
import prettyBytes from "pretty-bytes";
import { Tty } from "../util/tty.js";
import { Spinner } from "./spinner.js";

export type AssetProgress = {
  complete?: boolean;
  fileName: string;
  totalBytes?: number;
  writtenBytes?: number;
};

export class AssetReporter {
  private readonly assets = new Map<string, AssetProgress>();
  private readonly ownTty: boolean;
  private readonly spinner: Spinner;
  private readonly tty: Tty;

  constructor(tty?: Tty) {
    this.ownTty = !tty;
    this.tty = tty ?? new Tty();
    this.spinner = new Spinner(this.render, this.tty.isEnabled);
  }

  public close(): void {
    this.spinner.isEnabled = false;
    this.assets.clear();

    if (this.ownTty) {
      this.tty.done(true);
    }
  }

  public onProgress(event: AssetProgress): void {
    if (event.complete) {
      if (this.assets.delete(event.fileName) && !this.assets.size) {
        this.spinner.isEnabled = false;
      }

      const total = event.totalBytes ?? event.writtenBytes;
      const totalText = total !== undefined ? ` (${prettyBytes(total)})` : "";
      this.tty.interrupt(`${logSymbols.success} ${event.fileName}${totalText}`);
    } else {
      if (!this.assets.has(event.fileName)) {
        this.assets.set(event.fileName, event);

        if (this.assets.size === 1 && this.tty.isEnabled) {
          this.spinner.isEnabled = true;
        }
      }
      if (event.totalBytes !== event.writtenBytes && this.tty.isEnabled) {
        // only write a log if not a TTY
        this.tty.fallback(`${logSymbols.info} ${this.getStatusText(event)}: `);
      }
    }
  }

  private readonly render = (): void => {
    const lines: string[] = [];
    const spinner = this.spinner.frame;

    for (const asset of this.assets.values()) {
      const text = this.getStatusText(asset);
      lines.push(`${spinner} ${text}`);
    }

    this.tty.display(this, lines.join(`\n`));
  };

  private getStatusText(event: AssetProgress): string {
    const progress = prettyBytes(event.writtenBytes ?? 0);

    const total =
      event.totalBytes !== undefined ? prettyBytes(event.totalBytes) : "?";

    return `${event.fileName} ${progress} of ${total}`;
  }
}
