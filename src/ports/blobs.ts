/**
 * Content-addressed storage for published files.
 *
 * Keys mirror the directory layout the Node driver still uses on disk:
 * `sites/<site-id>/<version-id>/<path>`. Deleting a version or a whole site is a
 * prefix delete, which is a directory removal on Node and a bulk delete on R2.
 */
export interface Blobs {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Returns undefined when the key does not exist. */
  get(key: string): Promise<BlobBody | undefined>;
  /** Reads a whole object into memory. Used for republishing, not for serving. */
  getBytes(key: string): Promise<Uint8Array | undefined>;
  exists(key: string): Promise<boolean>;
  deletePrefix(prefix: string): Promise<void>;
}

export type BlobBody = {
  /** Streamed straight to the response; never buffered for serving. */
  body: ReadableStream<Uint8Array>;
  size: number;
  /** Strong validator for conditional requests, quoted per RFC 9110. */
  etag: string;
};
