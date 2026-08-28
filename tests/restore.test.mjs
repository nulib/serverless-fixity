// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  estimateWaitInSeconds,
  needsRestore,
  parseRestoreHeader,
  S3Restore,
} from '../src/lib/restore.mjs';

import {
  FakeS3,
} from './helpers/fakeS3.mjs';

const ETAG = '"0123456789abcdef0123456789abcdef"';

const payload = (overrides = {}) => ({
  Bucket: 'preservation',
  Key: 'masters/reel-1.mov',
  Algorithms: ['md5'],
  RestoreRequest: { Days: 1, Tier: 'Bulk' },
  ...overrides,
});

describe('parseRestoreHeader', () => {
  it('reads both fields despite the comma inside the date', () => {
    assert.deepEqual(
      parseRestoreHeader('ongoing-request="false", expiry-date="Fri, 21 Dec 2012 00:00:00 GMT"'),
      { ongoingRequest: false, expiryDate: new Date('Fri, 21 Dec 2012 00:00:00 GMT').getTime() }
    );
  });

  it('reads an in-flight restore', () => {
    assert.deepEqual(parseRestoreHeader('ongoing-request="true"'), {
      ongoingRequest: true,
      expiryDate: undefined,
    });
  });

  it('reports nothing for an object that was never archived', () => {
    assert.deepEqual(parseRestoreHeader(undefined), {});
  });
});

describe('needsRestore', () => {
  it('recognizes the archive storage classes', () => {
    assert.equal(needsRestore({ StorageClass: 'GLACIER' }), true);
    assert.equal(needsRestore({ StorageClass: 'DEEP_ARCHIVE' }), true);
  });

  it('recognizes archived Intelligent-Tiering objects', () => {
    assert.equal(needsRestore({ StorageClass: 'INTELLIGENT_TIERING', ArchiveStatus: 'ARCHIVE_ACCESS' }), true);
    assert.equal(needsRestore({ StorageClass: 'INTELLIGENT_TIERING', ArchiveStatus: 'DEEP_ARCHIVE_ACCESS' }), true);
    assert.equal(needsRestore({ StorageClass: 'INTELLIGENT_TIERING' }), false);
  });

  it('leaves directly readable objects alone', () => {
    assert.equal(needsRestore({}), false);
    assert.equal(needsRestore({ StorageClass: 'STANDARD' }), false);
    /* Glacier Instant Retrieval reads without a restore */
    assert.equal(needsRestore({ StorageClass: 'GLACIER_IR' }), false);
  });
});

describe('estimateWaitInSeconds', () => {
  it('waits longer for the colder classes', () => {
    const deep = estimateWaitInSeconds({ storageClass: 'DEEP_ARCHIVE', tier: 'Bulk' });
    const glacier = estimateWaitInSeconds({ storageClass: 'GLACIER', tier: 'Expedited' });
    assert.ok(deep > glacier);
  });

  it('counts down as the restore ages, but never below the class minimum', () => {
    const fresh = estimateWaitInSeconds({ storageClass: 'GLACIER', tier: 'Standard' });
    const aging = estimateWaitInSeconds({
      storageClass: 'GLACIER',
      tier: 'Standard',
      restoreStartAt: new Date(Date.now() - (2 * 3600 * 1000)).toISOString(),
    });
    assert.ok(aging < fresh);

    const stale = estimateWaitInSeconds({
      storageClass: 'GLACIER',
      tier: 'Standard',
      restoreStartAt: new Date(Date.now() - (99 * 3600 * 1000)).toISOString(),
    });
    assert.equal(stale, 3600);
  });
});

describe('S3Restore', () => {
  it('passes a directly readable object straight through', async () => {
    const s3 = new FakeS3({ HeadObject: { ETag: ETAG, ContentLength: 4096 } });
    const response = await new S3Restore(payload(), { s3 }).checkStatus();

    assert.equal(response.RestoreStatus, 'COMPLETED');
    assert.equal(response.Status, 'COMPLETED');
    assert.equal(response.ETag, ETAG);
    assert.equal(response.FileSize, 4096);
    assert.equal(s3.callsTo('RestoreObject').length, 0);
  });

  it('starts a restore for an archived object and says how long to wait', async () => {
    const s3 = new FakeS3({
      HeadObject: { ETag: ETAG, ContentLength: 4096, StorageClass: 'GLACIER' },
      RestoreObject: {},
    });
    const response = await new S3Restore(payload(), { s3 }).checkStatus();

    assert.equal(response.RestoreStatus, 'IN_PROGRESS');
    assert.ok(response.WaitInSeconds > 0);
    assert.ok(response.RestoreStartAt);

    const [request] = s3.callsTo('RestoreObject');
    assert.equal(request.input.RestoreRequest.Days, 1);
    assert.equal(request.input.RestoreRequest.GlacierJobParameters.Tier, 'Bulk');
  });

  it('does not ask twice while a restore is already running', async () => {
    const s3 = new FakeS3({
      HeadObject: {
        ETag: ETAG, ContentLength: 4096, StorageClass: 'DEEP_ARCHIVE', Restore: 'ongoing-request="true"',
      },
    });
    const response = await new S3Restore(payload({ RestoreStartAt: new Date().toISOString() }), { s3 }).checkStatus();

    assert.equal(response.RestoreStatus, 'IN_PROGRESS');
    assert.equal(s3.callsTo('RestoreObject').length, 0);
  });

  it('recognizes a finished restore', async () => {
    const s3 = new FakeS3({
      HeadObject: {
        ETag: ETAG,
        ContentLength: 4096,
        StorageClass: 'GLACIER',
        Restore: 'ongoing-request="false", expiry-date="Fri, 21 Dec 2035 00:00:00 GMT"',
      },
    });
    const response = await new S3Restore(payload(), { s3 }).checkStatus();

    assert.equal(response.RestoreStatus, 'COMPLETED');
    assert.ok(response.RestoreExpiredAt > 0);
    assert.equal(s3.callsTo('RestoreObject').length, 0);
  });

  it('downgrades Expedited to Standard for Deep Archive, which has no such tier', async () => {
    const s3 = new FakeS3({
      HeadObject: { ETag: ETAG, ContentLength: 4096, StorageClass: 'DEEP_ARCHIVE' },
      RestoreObject: {},
    });
    const response = await new S3Restore(payload({ RestoreRequest: { Days: 1, Tier: 'Expedited' } }), { s3 }).checkStatus();

    assert.equal(s3.callsTo('RestoreObject')[0].input.RestoreRequest.GlacierJobParameters.Tier, 'Standard');
    assert.equal(response.RestoreRequest.Tier, 'Standard');
  });

  it('refuses to continue if the object changed between polls', async () => {
    const s3 = new FakeS3({ HeadObject: { ETag: '"different"', ContentLength: 4096 } });
    await assert.rejects(
      new S3Restore(payload({ ETag: ETAG }), { s3 }).checkStatus(),
      /object changed/
    );
  });
});
