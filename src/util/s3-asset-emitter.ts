import type {
  AssetEmitter,
  AssetLike,
} from "@awboost/cfn-template-builder/builder";
import type {
  AssetEmitterProgress,
  AssetInfo,
  SchedulerFunction,
} from "@awboost/cfn-template-builder/emitter";
import { S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { Transform } from "node:stream";
import limit from "p-limit";
import { TypedEventEmitterBase } from "../internal/events.js";

export type S3AssetEmitterOptions = {
  bucket: string;
  objectKeyPrefix?: string;
  s3?: S3Client;
  s3Config?: S3ClientConfig;
  scheduler?: SchedulerFunction;
};

type S3AssetEmitterResolvedOptions = {
  bucket: string;
  objectKeyPrefix: string;
  scheduler: SchedulerFunction;
};

/**
 * Class which can emit assets to the file system.
 */
export class S3AssetEmitter
  extends TypedEventEmitterBase<{
    progress(event: AssetEmitterProgress): void;
  }>
  implements AssetEmitter
{
  private readonly options: S3AssetEmitterResolvedOptions;
  private readonly results: PromiseLike<AssetInfo>[] = [];
  private readonly s3: S3Client;

  constructor(options: S3AssetEmitterOptions) {
    super();

    this.options = {
      bucket: options.bucket,
      objectKeyPrefix: options.objectKeyPrefix ?? "",
      scheduler: options.scheduler ?? limit(4),
    };

    this.s3 = options.s3 ?? new S3Client(options.s3Config ?? {});
  }

  /**
   * Add an asset to the output.
   */
  public addAsset(asset: AssetLike): void {
    this.results.push(this.options.scheduler(() => this.emitAsset(asset)));
  }

  /**
   * Wait for all assets to be emitted.
   * @returns Information about each asset that was emitted.
   */
  public async done(): Promise<AssetInfo[]> {
    return Promise.all(this.results);
  }

  private async emitAsset(asset: AssetLike): Promise<AssetInfo> {
    const contentStream = asset.createReadStream();
    let measuredSize = 0;

    const upload = new Upload({
      client: this.s3,
      params: {
        Body: contentStream.pipe(
          new Transform({
            transform: (chunk, encoding, callback) => {
              measuredSize += chunk.length;
              callback(undefined, chunk);
            },
          }),
        ),
        Bucket: this.options.bucket,
        Key: this.options.objectKeyPrefix + asset.fileName,
      },
    });

    upload.on("httpUploadProgress", (progress) => {
      this.emit("progress", {
        fileName: asset.fileName,
        totalBytes: progress.total,
        writtenBytes: progress.loaded,
      });
    });

    await upload.done();

    const info = {
      fileName: asset.fileName,
      totalBytes: measuredSize,
    };

    // report completion measured size
    this.emit("progress", { complete: true, ...info });
    return info;
  }
}
