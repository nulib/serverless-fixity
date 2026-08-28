// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';

import {
  getS3Client,
} from './awsClients.mjs';

import {
  ChecksumSet,
} from './hash/index.mjs';

import {
  DEFAULT_CHUNK_SIZE,
  FixityState,
} from './fixityState.mjs';

import {
  ChecksumError,
  MismatchETagError,
  MismatchFileSizeError,
} from './errors.mjs';

const STATE_NAME = 'ComputeChecksum';

/**
 * Time held back from the invocation budget so that, once we stop reading, the
 * suspended hash state still has room to be serialized and returned.
 */
const DEADLINE_RESERVE_MS = 20 * 1000;

/**
 * Objects at or below this size are hashed with node:crypto in a single pass,
 * which is roughly an order of magnitude faster than the resumable
 * implementations but cannot be suspended part-way. Above it we always use the
 * resumable path so a long read can be spread over several invocations.
 */
export const DEFAULT_SINGLE_PASS_LIMIT = 8 * 1024 * 1024 * 1024;

/**
 * Compute the requested digests over one contiguous range of the object.
 *
 * All algorithms advance together over a single byte stream: the object is read
 * exactly once per range regardless of how many digests were asked for. The
 * loop yields when the invocation deadline approaches, handing the partially
 * advanced hash state back to the state machine to resume with.
 */
export class ChecksumCompute extends FixityState {
  /**
   * @param {object} payload state machine payload
   * @param {object} [options]
   * @param {object} [options.s3] S3 client override, for tests
   * @param {() => number} [options.remainingTimeInMillis] the Lambda context's
   *   clock; defaults to an effectively unbounded budget
   * @param {number} [options.singlePassLimit]
   */
  constructor(payload = {}, {
    s3,
    remainingTimeInMillis = () => Number.MAX_SAFE_INTEGER,
    singlePassLimit,
  } = {}) {
    super(STATE_NAME, payload);
    this.s3 = s3 ?? getS3Client(this.credentials);
    this.remainingTimeInMillis = remainingTimeInMillis;
    this.singlePassLimit = singlePassLimit
      ?? Number(process.env.ENV_SINGLE_PASS_LIMIT ?? DEFAULT_SINGLE_PASS_LIMIT);

    this.chunkSize = Number(payload.ChunkSize ?? DEFAULT_CHUNK_SIZE);
    this.byteStart = Number(payload.NextByteStart ?? 0);
    this.intermediateHashes = payload.IntermediateHashes;
    /* set after a single-pass attempt ran out of time; forces the slower but
     * suspendable path on the retry */
    this.forceResumable = payload.ForceResumable === true;
  }

  /**
   * Whether the hashes have to be suspendable. Resuming an earlier range, or
   * facing more bytes than we are willing to bet on finishing in one go, both
   * rule out node:crypto.
   */
  get mustBeResumable() {
    return this.forceResumable
      || this.byteStart > 0
      || this.intermediateHashes !== undefined
      || this.fileSize > Math.min(this.chunkSize, this.singlePassLimit);
  }

  async compute() {
    if (this.fileSize === undefined || this.etag === undefined) {
      /* CheckRestoreStatus normally pins these; be forgiving if a caller
       * invokes this state directly */
      await this.pinObject();
    }

    if (this.fileSize === 0) {
      return this.finish(ChecksumSet.create(this.algorithms, { resumable: false }), 0);
    }

    const resumable = this.mustBeResumable;
    const checksums = this.intermediateHashes
      ? ChecksumSet.restore(this.intermediateHashes)
      : ChecksumSet.create(this.algorithms, { resumable });

    const rangeEnd = Math.min(this.byteStart + this.chunkSize, this.fileSize) - 1;
    const deadline = Date.now() + this.remainingTimeInMillis() - DEADLINE_RESERVE_MS;

    console.log(JSON.stringify({
      message: 'computing checksums',
      bucket: this.bucket,
      key: this.key,
      algorithms: this.algorithms,
      range: `${this.byteStart}-${rangeEnd}`,
      fileSize: this.fileSize,
      resumable,
    }));

    const response = await this.s3.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: this.key,
      Range: `bytes=${this.byteStart}-${rangeEnd}`,
      IfMatch: this.etag,
    }));

    let bytesRead = 0;
    let ranOutOfTime = false;

    for await (const chunk of response.Body) {
      checksums.update(chunk);
      bytesRead += chunk.length;

      if (Date.now() >= deadline) {
        ranOutOfTime = true;
        response.Body.destroy();
        break;
      }
    }

    const byteEnd = this.byteStart + bytesRead;
    if (byteEnd > this.fileSize) {
      throw new MismatchFileSizeError(`read ${byteEnd} bytes, past the expected file size of ${this.fileSize}`);
    }

    if (byteEnd === this.fileSize) {
      return this.finish(checksums, bytesRead);
    }

    if (bytesRead === 0) {
      /* Without this the state machine would loop on an unchanged payload
       * forever, since NextByteStart could never advance. */
      throw new ChecksumError(`read no bytes from s3://${this.bucket}/${this.key} at offset ${this.byteStart} of ${this.fileSize}`);
    }

    if (ranOutOfTime && !resumable) {
      /* A single-pass attempt cannot be suspended, so the work done so far is
       * lost. Report no progress and pin the resumable path for the retry. */
      console.warn(`single-pass read of s3://${this.bucket}/${this.key} ran out of time after ${bytesRead} bytes; retrying with resumable hashes`);
      return this.responseData({
        BytesRead: 0,
        NextByteStart: 0,
        ForceResumable: true,
      });
    }

    /* IntermediateHashes is itself enough to pin the resumable path on the way
     * back in, so ForceResumable is left to whatever the payload already said */
    return this.responseData({
      BytesRead: bytesRead,
      NextByteStart: byteEnd,
      IntermediateHashes: checksums.serialize(),
    });
  }

  finish(checksums, bytesRead) {
    this.status = 'COMPLETED';
    return this.responseData({
      BytesRead: bytesRead,
      NextByteStart: this.fileSize,
      Computed: checksums.digest(),
      IntermediateHashes: undefined,
      ForceResumable: undefined,
    });
  }

  async pinObject() {
    const head = await this.s3.send(new HeadObjectCommand({
      Bucket: this.bucket,
      Key: this.key,
    }));

    this.etag ??= head.ETag;
    if (this.etag !== head.ETag) {
      throw new MismatchETagError(`object changed: expected ETag ${this.etag}, found ${head.ETag}`);
    }

    const contentLength = Number(head.ContentLength);
    this.fileSize ??= contentLength;
    if (this.fileSize !== contentLength) {
      throw new MismatchFileSizeError(`expected ${this.fileSize} bytes, found ${contentLength}`);
    }
  }
}

export {
  DEADLINE_RESERVE_MS,
  STATE_NAME,
};
