// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';

import {
  ChecksumCompute,
} from '../src/lib/compute.mjs';

import {
  SUPPORTED_ALGORITHMS,
} from '../src/lib/hash/index.mjs';

import {
  FakeS3,
  rangedObject,
} from './helpers/fakeS3.mjs';

const ETAG = '"0123456789abcdef0123456789abcdef"';

const digestsOf = (body) => Object.fromEntries(
  SUPPORTED_ALGORITHMS.map((algorithm) => [algorithm, createHash(algorithm).update(body).digest('hex')])
);

const baseRequest = (body, overrides = {}) => ({
  Bucket: 'preservation',
  Key: 'masters/reel-1.mov',
  Algorithms: SUPPORTED_ALGORITHMS,
  ETag: ETAG,
  FileSize: body.length,
  ...overrides,
});

/**
 * Drive the state as the state machine would: keep feeding the response back
 * into a fresh instance until it reports COMPLETED.
 */
async function runToCompletion(body, payload, options = {}) {
  const s3 = new FakeS3({ GetObject: rangedObject(body, { chunkSize: options.chunkSize ?? 4096 }) });

  let current = payload;
  let invocations = 0;
  while (current.Status !== 'COMPLETED') {
    invocations += 1;
    assert.ok(invocations < 100, 'compute loop failed to converge');
     
    current = await new ChecksumCompute(current, { s3, ...options.state }).compute();
  }
  return { response: current, invocations, s3 };
}

describe('ChecksumCompute', () => {
  it('computes every algorithm from one read of the object', async () => {
    const body = randomBytes(50000);
    const { response, invocations, s3 } = await runToCompletion(body, baseRequest(body));

    assert.equal(invocations, 1);
    assert.deepEqual(response.Computed, digestsOf(body));
    assert.equal(response.Status, 'COMPLETED');
    assert.equal(response.BytesRead, body.length);
    /* one range request for all three digests, not one per algorithm */
    assert.equal(s3.callsTo('GetObject').length, 1);
  });

  it('spreads a large object over several invocations and still agrees with node:crypto', async () => {
    const body = randomBytes(50000);
    const { response, invocations, s3 } = await runToCompletion(
      body,
      baseRequest(body, { ChunkSize: 8000 })
    );

    assert.ok(invocations > 1, 'expected the read to span invocations');
    assert.equal(invocations, Math.ceil(body.length / 8000));
    assert.deepEqual(response.Computed, digestsOf(body));
    assert.ok(!('IntermediateHashes' in response), 'hash state should be cleared once complete');

    const ranges = s3.callsTo('GetObject').map((call) => call.input.Range);
    assert.equal(ranges[0], 'bytes=0-7999');
    assert.equal(ranges[1], 'bytes=8000-15999');
    /* every byte requested exactly once, in order */
    assert.equal(ranges.length, invocations);
  });

  it('suspends when the invocation deadline nears and resumes where it left off', async () => {
    const body = randomBytes(40000);

    /* a budget that expires immediately after the first chunk */
    let remaining = 20 * 1000 + 5;
    const state = {
      remainingTimeInMillis: () => {
        remaining -= 1000;
        return remaining;
      },
      /* force the resumable path so the partial work can be carried over */
      singlePassLimit: 0,
    };

    const s3 = new FakeS3({ GetObject: rangedObject(body, { chunkSize: 4096 }) });
    const partial = await new ChecksumCompute(baseRequest(body), { s3, ...state }).compute();

    assert.equal(partial.Status, 'STARTED');
    assert.ok(partial.NextByteStart > 0 && partial.NextByteStart < body.length);
    assert.deepEqual(Object.keys(partial.IntermediateHashes).sort(), [...SUPPORTED_ALGORITHMS].sort());

    /* the suspended state must survive a JSON round trip through Step Functions */
    const { response } = await runToCompletion(body, JSON.parse(JSON.stringify(partial)), {
      state: { singlePassLimit: 0 },
    });
    assert.deepEqual(response.Computed, digestsOf(body));
  });

  it('falls back to the resumable path when a single pass runs out of time', async () => {
    const body = randomBytes(40000);

    let remaining = 20 * 1000 + 5;
    const s3 = new FakeS3({ GetObject: rangedObject(body, { chunkSize: 4096 }) });
    const retry = await new ChecksumCompute(baseRequest(body), {
      s3,
      remainingTimeInMillis: () => {
        remaining -= 1000;
        return remaining;
      },
      /* large enough that the first attempt takes the node:crypto path */
      singlePassLimit: Number.MAX_SAFE_INTEGER,
    }).compute();

    /* node:crypto state cannot be suspended, so the range restarts -- but the
     * retry is pinned to the resumable implementation */
    assert.equal(retry.NextByteStart, 0);
    assert.equal(retry.ForceResumable, true);
    assert.ok(!('IntermediateHashes' in retry));

    const { response } = await runToCompletion(body, retry);
    assert.deepEqual(response.Computed, digestsOf(body));
  });

  it('handles a zero-byte object without reading it', async () => {
    const body = Buffer.alloc(0);
    const s3 = new FakeS3({});
    const response = await new ChecksumCompute(baseRequest(body), { s3 }).compute();

    assert.equal(response.Status, 'COMPLETED');
    assert.deepEqual(response.Computed, digestsOf(body));
    assert.equal(s3.calls.length, 0);
  });

  it('pins the range read to the ETag so a mid-run overwrite is caught', async () => {
    const body = randomBytes(1000);
    const { s3 } = await runToCompletion(body, baseRequest(body));
    assert.equal(s3.callsTo('GetObject')[0].input.IfMatch, ETAG);
  });

  it('never asks for bytes past the end of the object', async () => {
    const body = randomBytes(1000);
    const { s3 } = await runToCompletion(body, baseRequest(body, { ChunkSize: 4096 }));
    assert.equal(s3.callsTo('GetObject')[0].input.Range, 'bytes=0-999');
  });

  it('looks the object up itself when invoked without an ETag or size', async () => {
    const body = randomBytes(1000);
    const s3 = new FakeS3({
      HeadObject: { ETag: ETAG, ContentLength: body.length },
      GetObject: rangedObject(body),
    });

    const response = await new ChecksumCompute({
      Bucket: 'preservation',
      Key: 'masters/reel-1.mov',
      Algorithms: ['sha256'],
    }, { s3 }).compute();

    assert.equal(response.Status, 'COMPLETED');
    assert.equal(response.ETag, ETAG);
    assert.equal(response.Computed.sha256, digestsOf(body).sha256);
  });

  it('rejects an object whose size changed since the run started', async () => {
    const s3 = new FakeS3({ HeadObject: { ETag: ETAG, ContentLength: 999 } });
    await assert.rejects(
      new ChecksumCompute({ Bucket: 'b', Key: 'k', FileSize: 1000 }, { s3 }).compute(),
      /MismatchFileSizeError|expected 1000 bytes/
    );
  });

  it('rejects an object whose ETag changed since the run started', async () => {
    const s3 = new FakeS3({ HeadObject: { ETag: '"deadbeef"', ContentLength: 1000 } });
    await assert.rejects(
      new ChecksumCompute({ Bucket: 'b', Key: 'k', ETag: ETAG }, { s3 }).compute(),
      /object changed/
    );
  });

  it('fails loudly rather than looping when a range comes back empty', async () => {
    const body = randomBytes(40000);
    /* an empty body for a non-final range would otherwise leave NextByteStart
     * unchanged, and the state machine would loop on it forever */
    const s3 = new FakeS3({ GetObject: () => ({ Body: Readable.from([]) }) });

    await assert.rejects(
      new ChecksumCompute(baseRequest(body), { s3, singlePassLimit: 0 }).compute(),
      /read no bytes/
    );
  });

  it('still makes progress when the deadline has already passed', async () => {
    const body = randomBytes(40000);
    const s3 = new FakeS3({ GetObject: rangedObject(body, { chunkSize: 4096 }) });

    const response = await new ChecksumCompute(baseRequest(body), {
      s3,
      remainingTimeInMillis: () => 0,
      singlePassLimit: 0,
    }).compute();

    assert.ok(response.NextByteStart > 0, 'at least one chunk must always be consumed');
  });

  it('computes a single algorithm when only one is asked for', async () => {
    const body = randomBytes(5000);
    const { response } = await runToCompletion(body, baseRequest(body, { Algorithms: undefined, Algorithm: 'sha1' }));
    assert.deepEqual(response.Computed, { sha1: digestsOf(body).sha1 });
  });
});
