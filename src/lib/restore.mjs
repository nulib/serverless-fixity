// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  HeadObjectCommand,
  RestoreObjectCommand,
} from '@aws-sdk/client-s3';

import {
  getS3Client,
} from './awsClients.mjs';

import {
  FixityState,
} from './fixityState.mjs';

import {
  MismatchETagError,
} from './errors.mjs';

const STATE_NAME = 'CheckRestoreStatus';

const GLACIER = 'GLACIER';
const DEEP_ARCHIVE = 'DEEP_ARCHIVE';

/**
 * Typical restore windows per storage class and retrieval tier, as
 * [minimum, maximum] seconds. We poll no more often than the minimum, because
 * every poll is a state transition we would rather not pay for.
 */
const RESTORE_WINDOWS = {
  [DEEP_ARCHIVE]: {
    Bulk: [6 * 3600, 24 * 3600],
    Standard: [2 * 3600, 8 * 3600],
    /* Deep Archive has no Expedited tier; requests are downgraded to Standard */
    Expedited: [2 * 3600, 8 * 3600],
  },
  [GLACIER]: {
    Bulk: [2 * 3600, 8 * 3600],
    Standard: [3600, 4 * 3600],
    Expedited: [120, 300],
  },
};

const DEFAULT_WINDOW = [3600, 3600];

/**
 * Parse the S3 `x-amz-restore` header, e.g.
 * `ongoing-request="false", expiry-date="Fri, 21 Dec 2012 00:00:00 GMT"`.
 * Reading the two fields by name sidesteps the comma inside the date.
 */
export function parseRestoreHeader(header) {
  if (!header) {
    return {};
  }
  const ongoing = /ongoing-request\s*=\s*"([^"]*)"/i.exec(header);
  const expiry = /expiry-date\s*=\s*"([^"]*)"/i.exec(header);
  return {
    ongoingRequest: ongoing ? ongoing[1].toLowerCase() === 'true' : undefined,
    expiryDate: expiry ? new Date(expiry[1]).getTime() : undefined,
  };
}

/**
 * True when the object's bytes are not directly readable and a restore has to
 * be requested first. Intelligent-Tiering objects report this through
 * ArchiveStatus rather than StorageClass.
 */
export function needsRestore({ StorageClass, ArchiveStatus } = {}) {
  return StorageClass === GLACIER
    || StorageClass === DEEP_ARCHIVE
    || ArchiveStatus === 'ARCHIVE_ACCESS'
    || ArchiveStatus === 'DEEP_ARCHIVE_ACCESS';
}

/**
 * How long to wait before polling again. Restores complete somewhere inside a
 * broad window, so we wait out the remainder of the optimistic estimate but
 * never less than the class minimum.
 */
export function estimateWaitInSeconds({ storageClass, tier, restoreStartAt }) {
  const [minWait, maxWait] = RESTORE_WINDOWS[storageClass]?.[tier] ?? DEFAULT_WINDOW;
  const elapsed = restoreStartAt
    ? Math.floor((Date.now() - new Date(restoreStartAt).getTime()) / 1000)
    : 0;
  return Math.max(minWait, maxWait - elapsed);
}

/**
 * First state of the run: pin the object's identity and, if it is archived,
 * kick off a restore and report how long the state machine should wait.
 */
export class S3Restore extends FixityState {
  constructor(payload = {}, { s3 } = {}) {
    super(STATE_NAME, payload);
    this.s3 = s3 ?? getS3Client();
    this.restoreRequest = payload.RestoreRequest ?? {};
    this.restoreStartAt = payload.RestoreStartAt;
  }

  async checkStatus() {
    const head = await this.s3.send(new HeadObjectCommand({
      Bucket: this.bucket,
      Key: this.key,
    }));

    /* pin ETag and size on the first look so a mid-run overwrite is caught
     * rather than silently folded into the digest */
    this.etag ??= head.ETag;
    if (this.etag !== head.ETag) {
      throw new MismatchETagError(`object changed: expected ETag ${this.etag}, found ${head.ETag}`);
    }
    this.fileSize ??= Number(head.ContentLength);

    const {
      ongoingRequest,
      expiryDate,
    } = parseRestoreHeader(head.Restore);

    const storageClass = head.StorageClass ?? 'STANDARD';

    if (!needsRestore(head) || ongoingRequest === false) {
      this.status = 'COMPLETED';
      return this.responseData({
        StorageClass: storageClass,
        ArchiveStatus: head.ArchiveStatus,
        RestoreStatus: 'COMPLETED',
        RestoreExpiredAt: expiryDate,
        WaitInSeconds: undefined,
      });
    }

    /* Deep Archive offers no Expedited retrieval */
    const tier = (storageClass === DEEP_ARCHIVE && this.restoreRequest.Tier === 'Expedited')
      ? 'Standard'
      : this.restoreRequest.Tier;

    if (ongoingRequest === undefined) {
      console.log(`requesting ${tier} restore of s3://${this.bucket}/${this.key} (${storageClass})`);
      await this.s3.send(new RestoreObjectCommand({
        Bucket: this.bucket,
        Key: this.key,
        RestoreRequest: {
          Days: this.restoreRequest.Days,
          GlacierJobParameters: { Tier: tier },
        },
      }));
    }

    this.restoreStartAt ??= new Date().toISOString();

    return this.responseData({
      StorageClass: storageClass,
      ArchiveStatus: head.ArchiveStatus,
      RestoreStatus: 'IN_PROGRESS',
      RestoreRequest: { ...this.restoreRequest, Tier: tier },
      RestoreStartAt: this.restoreStartAt,
      WaitInSeconds: estimateWaitInSeconds({
        storageClass,
        tier,
        restoreStartAt: this.restoreStartAt,
      }),
    });
  }
}

export {
  GLACIER,
  DEEP_ARCHIVE,
  STATE_NAME,
};
