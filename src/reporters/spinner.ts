import cliSpinners from "cli-spinners";

export class Spinner {
  private frameIndex = 0;
  private handle: NodeJS.Timeout | undefined;

  public color: ((text: string) => string) | undefined;
  public type = cliSpinners.line;

  public get frame(): string {
    const frame = this.type.frames[this.frameIndex]!;
    return this.color ? this.color(frame) : frame;
  }

  public get isEnabled(): boolean {
    return !!this.handle;
  }
  public set isEnabled(value: boolean) {
    if (this.handle && !value) {
      clearInterval(this.handle);
      this.handle = undefined;
    } else if (!this.handle && value) {
      this.handle = setInterval(this.render, this.type.interval);
      this.handle.unref();
    }
  }

  constructor(
    private readonly renderCallback: () => void,
    enabled = true,
  ) {
    this.isEnabled = enabled;
  }

  private readonly render = (): void => {
    this.renderCallback();
    this.frameIndex = (this.frameIndex + 1) % this.type.frames.length;
  };
}
