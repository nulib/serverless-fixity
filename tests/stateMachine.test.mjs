// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The states hand a payload to one another through Step Functions, so what one
 * returns has to be something the next can construct itself from. These tests
 * walk a whole run to hold that contract in place.
 */

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  ChecksumCompute,
} from '../src/lib/compute.mjs';

import {
  ChecksumValidation,
} from '../src/lib/validate.mjs';

import {
  S3Restore,
} from '../src/lib/restore.mjs';

import {
  normalizeRequest,
} from '../src/lib/fixityState.mjs';

import {
  FakeS3,
  rangedObject,
} from './helpers/fakeS3.mjs';

const definition = JSON.parse(readFileSync(new URL('../statemachine/fixity.asl.json', import.meta.url)));

/* multipart form: not an MD5 of the object, so nothing to compare against
 * unless a test arranges one */
const ETAG = '"0123456789abcdef0123456789abcdef-32"';

/**
 * Run the state machine's control flow against the real state classes, taking
 * the same branches fixity.asl.json takes: on `$.RestoreStatus` after
 * CheckRestoreStatus, and on `$.Status` after ComputeChecksum.
 */
async function execute(body, request, { s3, storageClass, computeOptions = {} } = {}) {
  const client = s3 ?? new FakeS3({
    HeadObject: { ETag: ETAG, ContentLength: body.length, StorageClass: storageClass },
    RestoreObject: {},
    GetObject: rangedObject(body, { chunkSize: 4096 }),
    GetObjectTagging: { TagSet: [] },
    PutObjectTagging: {},
  });

  /* Step Functions serializes the payload between every state; do the same so a
   * value that cannot survive JSON is caught here rather than in production. */
  const hop = (payload) => JSON.parse(JSON.stringify(payload));

  const run = {
    CheckRestoreStatus: (payload) => new S3Restore(payload, { s3: client }).checkStatus(),
    ComputeChecksum: (payload) => new ChecksumCompute(payload, { s3: client, ...computeOptions }).compute(),
    FinalValidation: (payload) => new ChecksumValidation(payload, { s3: client }).run(),
  };

  let state = definition.StartAt;
  let payload = hop(normalizeRequest(request));
  const visited = [];

  for (let transitions = 0; transitions < 200; transitions += 1) {
    visited.push(state);
    payload = hop(await run[state](payload));

    if (state === 'FinalValidation') {
      return { output: payload, visited, s3: client };
    }
    if (state === 'CheckRestoreStatus') {
      /* RestoreCompleted? -- the Wait state changes no data, so it is elided */
      state = payload.RestoreStatus === 'COMPLETED' ? 'ComputeChecksum' : 'CheckRestoreStatus';
    } else {
      /* MoreData? */
      state = payload.Status === 'COMPLETED' ? 'FinalValidation' : 'ComputeChecksum';
    }
  }

  throw new Error('the run did not converge');
}

describe('the state machine definition', () => {
  it('routes every state the handlers implement', () => {
    assert.deepEqual(Object.keys(definition.States).sort(), [
      'CheckRestoreStatus', 'ComputeChecksum', 'FinalValidation', 'MoreData?', 'RestoreCompleted?', 'WaitForRestore',
    ]);
    assert.equal(definition.StartAt, 'CheckRestoreStatus');
  });

  it('never retries an error that cannot come good', () => {
    for (const name of ['CheckRestoreStatus', 'ComputeChecksum']) {
      const terminal = definition.States[name].Retry.find((rule) => rule.MaxAttempts === 0);
      assert.deepEqual(terminal.ErrorEquals, ['ForbiddenError', 'MismatchETagError', 'MismatchFileSizeError'], name);
    }
  });

  it('loops ComputeChecksum until the object is exhausted', () => {
    assert.equal(definition.States['MoreData?'].Default, 'ComputeChecksum');
    assert.equal(definition.States['MoreData?'].Choices[0].Next, 'FinalValidation');
    assert.equal(definition.States['MoreData?'].Choices[0].StringEquals, 'COMPLETED');
  });
});

describe('a whole run', () => {
  it('carries one payload from restore through to a tagged, validated object', async () => {
    const body = randomBytes(30000);
    const { output, visited, s3 } = await execute(body, {
      Bucket: 'preservation',
      Key: 'masters/reel-1.mov',
      Algorithms: ['md5', 'sha1', 'sha256'],
      ChunkSize: 10000,
    });

    assert.equal(output.Status, 'COMPLETED');
    assert.equal(output.State, 'FinalValidation');
    assert.equal(output.ComparedResult, 'SKIPPED');

    for (const algorithm of ['md5', 'sha1', 'sha256']) {
      assert.equal(
        output.Checksums[algorithm].Computed,
        createHash(algorithm).update(body).digest('hex'),
        algorithm
      );
      assert.equal(output.Checksums[algorithm].TagUpdated, true);
    }

    /* three ranges of a 30000-byte object at 10000 bytes each */
    assert.deepEqual(visited, [
      'CheckRestoreStatus', 'ComputeChecksum', 'ComputeChecksum', 'ComputeChecksum', 'FinalValidation',
    ]);
    assert.equal(s3.callsTo('GetObject').length, 3);
    assert.ok(output.Elapsed >= 0);
  });

  it('thaws an archived object before reading it', async () => {
    const body = randomBytes(5000);
    let restored = false;

    const s3 = new FakeS3({
      HeadObject: () => (restored
        ? { ETag: ETAG, ContentLength: body.length, StorageClass: 'GLACIER', Restore: 'ongoing-request="false"' }
        : { ETag: ETAG, ContentLength: body.length, StorageClass: 'GLACIER' }),
      RestoreObject: () => {
        restored = true;
        return {};
      },
      GetObject: rangedObject(body),
      GetObjectTagging: { TagSet: [] },
      PutObjectTagging: {},
    });

    const { output, visited } = await execute(body, {
      Bucket: 'preservation',
      Key: 'masters/reel-1.mov',
    }, { s3 });

    assert.deepEqual(visited, ['CheckRestoreStatus', 'CheckRestoreStatus', 'ComputeChecksum', 'FinalValidation']);
    assert.equal(s3.callsTo('RestoreObject').length, 1, 'a restore should be requested exactly once');
    assert.equal(output.Checksums.md5.Computed, createHash('md5').update(body).digest('hex'));
  });

  it('reports NOTMATCHED without failing the run, and leaves no tag behind', async () => {
    const body = randomBytes(5000);
    const wrong = 'f'.repeat(32);

    const { output, s3 } = await execute(body, {
      Bucket: 'preservation',
      Key: 'masters/reel-1.mov',
      Expected: wrong,
    });

    assert.equal(output.ComparedResult, 'NOTMATCHED');
    assert.equal(output.Status, 'COMPLETED');
    assert.equal(output.Checksums.md5.Expected, wrong);
    assert.equal(output.Checksums.md5.TagUpdated, false);
    assert.equal(s3.callsTo('PutObjectTagging').length, 0);
  });

  it('compares against a single-part ETag when there is nothing better', async () => {
    const body = randomBytes(5000);
    const md5 = createHash('md5').update(body).digest('hex');

    const s3 = new FakeS3({
      /* an unencrypted single-part upload: the ETag really is the object's MD5 */
      HeadObject: { ETag: `"${md5}"`, ContentLength: body.length },
      GetObject: rangedObject(body),
      GetObjectTagging: { TagSet: [] },
      PutObjectTagging: {},
    });

    const { output } = await execute(body, { Bucket: 'preservation', Key: 'masters/reel-1.mov' }, { s3 });

    assert.equal(output.ComparedResult, 'MATCHED');
    assert.equal(output.Checksums.md5.ComparedWith, 'object-etag');
  });

  it('finds the tag it wrote on an earlier run', async () => {
    const body = randomBytes(5000);
    const md5 = createHash('md5').update(body).digest('hex');

    const s3 = new FakeS3({
      HeadObject: { ETag: ETAG, ContentLength: body.length },
      GetObject: rangedObject(body),
      GetObjectTagging: { TagSet: [{ Key: 'computed-md5', Value: md5 }] },
      PutObjectTagging: {},
    });

    const { output } = await execute(body, { Bucket: 'preservation', Key: 'masters/reel-1.mov' }, { s3 });

    assert.equal(output.ComparedResult, 'MATCHED');
    assert.equal(output.Checksums.md5.ComparedWith, 'object-tagging');
  });

  it('survives being suspended repeatedly mid-object', async () => {
    const body = randomBytes(30000);

    /* a clock that expires right after the first chunk of every invocation */
    const computeOptions = {
      remainingTimeInMillis: () => 20 * 1000,
      singlePassLimit: 0,
    };

    const { output, visited } = await execute(body, {
      Bucket: 'preservation',
      Key: 'masters/reel-1.mov',
      Algorithms: ['md5', 'sha256'],
    }, { computeOptions });

    /* 4096-byte chunks, one per invocation */
    assert.ok(visited.filter((state) => state === 'ComputeChecksum').length >= 7);
    assert.equal(output.Checksums.sha256.Computed, createHash('sha256').update(body).digest('hex'));
    assert.equal(output.Checksums.md5.Computed, createHash('md5').update(body).digest('hex'));
  });
});
