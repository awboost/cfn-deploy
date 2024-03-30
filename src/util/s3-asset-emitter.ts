import type {
  AssetEmitter,
  AssetLike,
} from "@awboost/cfn-template-builder/builder";
import type {
  AssetEmitterProgress,
  SchedulerFunction,
} from "@awboost/cfn-template-builder/emitter";
import {
  contentLength,
  makeContentStream,
} from "@awboost/cfn-template-builder/util/content";
import { S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
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
  private readonly results: PromiseLike<void>[] = [];
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
   */
  public async done(): Promise<void> {
    await Promise.all(this.results);
  }

  private async emitAsset(asset: AssetLike): Promise<void> {
    let writtenBytes = 0;

    const totalBytes = await contentLength(asset.content);
    const contentStream = makeContentStream(asset);

    const upload = new Upload({
      client: this.s3,
      params: {
        Body: contentStream,
        Bucket: this.options.bucket,
        Key: this.options.objectKeyPrefix + asset.fileName,
      },
    });

    upload.on("httpUploadProgress", (progress) => {
      if (progress.loaded) {
        writtenBytes = progress.loaded;
      }

      this.emit("progress", {
        fileName: asset.fileName,
        totalBytes: totalBytes ?? progress.total,
        writtenBytes: progress.loaded,
      });
    });

    await upload.done();

    // report completion measured size
    this.emit("progress", {
      complete: true,
      fileName: asset.fileName,
      totalBytes: totalBytes ?? writtenBytes,
    });
  }
}
