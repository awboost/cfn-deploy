import { createLogUpdate } from "log-update";

export type TtyOptions = {
  fps?: number;
  stream?: NodeJS.WriteStream;
};

export class Tty {
  private readonly displays = new Map<any, string>();
  private readonly renderInterval: number;
  private readonly stream: NodeJS.WriteStream;
  private readonly update: ReturnType<typeof createLogUpdate>;

  private lastRender = 0;
  private renderTimeout: NodeJS.Timeout | undefined;

  public get isEnabled(): boolean {
    return !!this.stream.isTTY;
  }

  public get windowHeight(): number {
    return this.stream.isTTY ? this.stream.rows ?? 24 : 0;
  }

  public get windowWidth(): number {
    return this.stream.isTTY ? this.stream.columns ?? 80 : 0;
  }

  constructor(options: TtyOptions = {}) {
    this.renderInterval = Math.floor(1000 / (options?.fps ?? 20));
    this.stream = options?.stream ?? process.stdout;
    this.update = createLogUpdate(this.stream);
  }

  public clear(): void {
    this.displays.clear();
    this.render();
  }

  public display(key: any, text: string): void {
    const existing = this.displays.get(key);
    if ((existing ?? "") === text) {
      return;
    }

    if (text) {
      this.displays.set(key, text);
    } else {
      this.displays.delete(key);
    }
    this.render();
  }

  public done(clear = false): void {
    this.displays.clear();
    this.cancelRender();

    if (clear) {
      this.update.clear();
    }
    this.update.done();
  }

  public fallback(text: string): void {
    if (!this.isEnabled) {
      this.stream.write(text + "\n");
    }
  }

  public interrupt(text: string): void {
    this.update.clear();
    this.stream.write(text + "\n");
    this.render();
  }

  private render(immediately = false): void {
    if (!this.isEnabled) {
      return;
    }
    const now = Date.now();

    if (immediately) {
      const content = [...this.displays.values()].join("\n");
      this.cancelRender();
      this.lastRender = now;

      if (content) {
        this.update(content);
      } else {
        this.update.clear();
      }
    } else if (!this.renderTimeout) {
      const timeSinceLastRender = now - this.lastRender;
      const nextRender = Math.max(0, this.renderInterval - timeSinceLastRender);
      this.renderTimeout = setTimeout(() => this.render(true), nextRender);
    }
  }

  private cancelRender(): void {
    if (this.renderTimeout) {
      clearTimeout(this.renderTimeout);
      this.renderTimeout = undefined;
    }
  }
}
