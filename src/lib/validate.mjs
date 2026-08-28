// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  GetObjectTaggingCommand,
  HeadObjectCommand,
  PutObjectTaggingCommand,
} from '@aws-sdk/client-s3';

import {
  getS3Client,
} from './awsClients.mjs';

import {
  DIGEST_HEX_LENGTH,
} from './hash/index.mjs';

import {
  FixityState,
} from './fixityState.mjs';

import {
  InvalidArgumentError,
} from './errors.mjs';

const STATE_NAME = 'FinalValidation';

const TAG_PREFIX = 'computed-';
const TAG_LASTMODIFIED_SUFFIX = '-last-modified';

/** S3 allows at most ten tags on an object. */
const MAX_OBJECT_TAGS = 10;

export const checksumTagName = (algorithm) => `${TAG_PREFIX}${algorithm}`;

export const lastModifiedTagName = (algorithm) => `${TAG_PREFIX}${algorithm}${TAG_LASTMODIFIED_SUFFIX}`;

/**
 * Final state of the run: compare each computed digest against a reference and
 * record the results on the object.
 *
 * Every algorithm is judged on its own -- one mismatched digest does not
 * suppress the others' findings -- and the run's overall verdict is the worst
 * of them.
 */
export class ChecksumValidation extends FixityState {
  constructor(payload = {}, { s3 } = {}) {
    super(STATE_NAME, payload);

    this.computed = payload.Computed;
    if (!this.computed || typeof this.computed !== 'object') {
      throw new InvalidArgumentError('missing Computed checksums');
    }
    const uncomputed = this.algorithms.filter((name) => !this.computed[name]);
    if (uncomputed.length > 0) {
      throw new InvalidArgumentError(`missing computed checksum(s) for ${uncomputed.join(', ')}`);
    }

    this.s3 = s3 ?? getS3Client(this.credentials);
    this.storeChecksumOnTagging = payload.StoreChecksumOnTagging !== false;
    this.tagSet = [];
    this.head = undefined;
  }

  async run() {
    this.tagSet = await this.getTags();

    const results = {};
    for (const algorithm of this.algorithms) {
      /* sequential on purpose: the reference lookups share one cached
       * HeadObject response, and there are at most a handful of algorithms */
      results[algorithm] = await this.compare(algorithm);
    }

    if (this.storeChecksumOnTagging) {
      await this.writeTags(results);
    }

    this.status = 'COMPLETED';

    return this.responseData({
      Checksums: results,
      ComparedResult: overallResult(results),
      /* folded into Checksums now that the run is done */
      Computed: undefined,
      Expected: undefined,
      IntermediateHashes: undefined,
      ForceResumable: undefined,
      BytesRead: undefined,
    });
  }

  async compare(algorithm) {
    const computed = this.computed[algorithm].toLowerCase();

    const {
      digest: reference,
      source,
    } = this.expected[algorithm]
      ? { digest: this.expected[algorithm], source: 'api' }
      : await this.findReference(algorithm);

    const result = {
      Computed: computed,
      ComparedWith: source,
      ComparedResult: 'SKIPPED',
    };

    if (reference) {
      result.Expected = reference;
      result.ComparedResult = reference.toLowerCase() === computed ? 'MATCHED' : 'NOTMATCHED';
    }
    return result;
  }

  /**
   * Look for a checksum already recorded against the object, in descending
   * order of trustworthiness. Returns `{ digest, source }`, with `source`
   * naming where it came from so the report is auditable.
   */
  async findReference(algorithm) {
    const tag = this.tagSet.find((entry) => entry.Key === checksumTagName(algorithm));
    if (tag && isWellFormed(tag.Value, algorithm)) {
      return { digest: tag.Value.toLowerCase(), source: 'object-tagging' };
    }

    const head = await this.getHead();

    /* x-amz-meta-md5 and friends, as set by whoever uploaded the object */
    const metadata = head.Metadata ?? {};
    const fromMetadata = metadata[algorithm];
    if (fromMetadata && isWellFormed(fromMetadata, algorithm)) {
      return { digest: fromMetadata.toLowerCase(), source: 'object-metadata' };
    }

    /* Last resort, MD5 only: an ETag is the object's MD5, but only for
     * single-part uploads that were not encrypted with KMS. */
    if (algorithm === 'md5') {
      const sse = head.ServerSideEncryption;
      if (!sse || sse.toLowerCase() === 'aes256') {
        const matched = /^"([0-9a-f]{32})"$/i.exec(head.ETag ?? '');
        if (matched) {
          return { digest: matched[1].toLowerCase(), source: 'object-etag' };
        }
      }
    }

    return { digest: undefined, source: 'none' };
  }

  /**
   * Record each digest as a `computed-<algorithm>` tag alongside a timestamp,
   * preserving any unrelated tags already on the object.
   *
   * A NOTMATCHED digest is deliberately not written: the tag is meant to be a
   * trustworthy record of the object's content.
   */
  async writeTags(results) {
    const ours = new Set(this.algorithms.flatMap(
      (algorithm) => [checksumTagName(algorithm), lastModifiedTagName(algorithm)]
    ));
    const preserved = this.tagSet.filter((entry) => !ours.has(entry.Key));
    const now = Date.now().toString();

    const tagSet = [...preserved];
    const skipped = [];
    for (const algorithm of this.algorithms) {
      if (results[algorithm].ComparedResult === 'NOTMATCHED') {
        results[algorithm].TagUpdated = false;
        continue;
      }
      if (tagSet.length + 2 > MAX_OBJECT_TAGS) {
        results[algorithm].TagUpdated = false;
        skipped.push(algorithm);
        continue;
      }
      tagSet.push(
        { Key: checksumTagName(algorithm), Value: results[algorithm].Computed },
        { Key: lastModifiedTagName(algorithm), Value: now }
      );
      results[algorithm].TagUpdated = true;
    }

    if (skipped.length > 0) {
      console.warn(`s3://${this.bucket}/${this.key} already carries ${preserved.length} tags; no room to record ${skipped.join(', ')}`);
    }

    const pending = this.algorithms.filter((algorithm) => results[algorithm].TagUpdated);
    if (pending.length === 0) {
      return;
    }

    try {
      await this.s3.send(new PutObjectTaggingCommand({
        Bucket: this.bucket,
        Key: this.key,
        Tagging: { TagSet: tagSet },
      }));
    } catch (e) {
      /* Tagging is a nice-to-have record, not the point of the run: report the
       * comparison rather than failing over a missing s3:PutObjectTagging. */
      console.error(`failed to tag s3://${this.bucket}/${this.key}:`, e);
      for (const algorithm of pending) {
        results[algorithm].TagUpdated = false;
      }
    }
  }

  async getTags() {
    try {
      const { TagSet = [] } = await this.s3.send(new GetObjectTaggingCommand({
        Bucket: this.bucket,
        Key: this.key,
      }));
      return TagSet;
    } catch (e) {
      console.warn(`unable to read tags on s3://${this.bucket}/${this.key}:`, e.message);
      return [];
    }
  }

  async getHead() {
    this.head ??= await this.s3.send(new HeadObjectCommand({
      Bucket: this.bucket,
      Key: this.key,
    }));
    return this.head;
  }
}

function isWellFormed(digest, algorithm) {
  return new RegExp(`^[0-9a-f]{${DIGEST_HEX_LENGTH[algorithm]}}$`, 'i').test(digest.trim());
}

/**
 * The run's verdict: a single mismatch fails the whole thing, otherwise any
 * confirmed match carries it, and a run with nothing to compare against is
 * reported as SKIPPED.
 */
export function overallResult(results) {
  const verdicts = Object.values(results).map((result) => result.ComparedResult);
  if (verdicts.includes('NOTMATCHED')) {
    return 'NOTMATCHED';
  }
  if (verdicts.includes('MATCHED')) {
    return 'MATCHED';
  }
  return 'SKIPPED';
}

export {
  MAX_OBJECT_TAGS,
  STATE_NAME,
};
