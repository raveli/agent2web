import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { BlobBody, Blobs } from '../../ports/blobs.js';
import { UserError } from '../../util/errors.js';

/**
 * Blobs backed by the local filesystem.
 *
 * Keys are relative POSIX paths and map one-to-one onto directories under the
 * data directory, so a deployment can be inspected, backed up and restored with
 * ordinary file tools — which is much of the point of the self-hosted target.
 */
export class NodeBlobs implements Blobs {
  constructor(private readonly root: string) {}

  async put(key: string, body: Uint8Array, _contentType: string): Promise<void> {
    const target = this.pathFor(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
  }

  async get(key: string): Promise<BlobBody | undefined> {
    const target = this.pathFor(key);
    let info;
    try {
      info = await stat(target);
    } catch {
      return undefined;
    }
    if (!info.isFile()) return undefined;
    return {
      body: Readable.toWeb(createReadStream(target)) as ReadableStream<Uint8Array>,
      size: info.size,
      etag: `"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`,
    };
  }

  async getBytes(key: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(this.pathFor(key)));
    } catch {
      return undefined;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await stat(this.pathFor(key))).isFile();
    } catch {
      return false;
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    await rm(this.pathFor(prefix), { recursive: true, force: true });
  }

  /**
   * Resolves a key to an absolute path, refusing anything that escapes the root.
   * Keys are built internally from validated ids and sanitised paths; this is the
   * backstop that makes that guarantee structural rather than assumed.
   */
  pathFor(key: string): string {
    const target = resolve(join(this.root, key));
    const root = resolve(this.root);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new UserError(`Blob key escapes the storage root: ${JSON.stringify(key)}.`);
    }
    return target;
  }
}
