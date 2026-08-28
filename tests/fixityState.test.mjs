// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_CHUNK_SIZE,
  FixityState,
  normalizeRequest,
  parseAlgorithms,
  parseExpected,
} from '../src/lib/fixityState.mjs';

const MD5 = 'd41d8cd98f00b204e9800998ecf8427e';
const SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('parseAlgorithms', () => {
  it('defaults to md5', () => {
    assert.deepEqual(parseAlgorithms({}), ['md5']);
  });

  it('accepts the single-algorithm spelling', () => {
    assert.deepEqual(parseAlgorithms({ Algorithm: 'SHA256' }), ['sha256']);
  });

  it('accepts a list, a comma-separated string, and mixed case', () => {
    assert.deepEqual(parseAlgorithms({ Algorithms: ['SHA256', 'md5'] }), ['md5', 'sha256']);
    assert.deepEqual(parseAlgorithms({ Algorithms: 'sha1, md5' }), ['md5', 'sha1']);
  });

  it('de-duplicates and returns a stable order', () => {
    assert.deepEqual(
      parseAlgorithms({ Algorithms: ['sha256', 'md5', 'sha256'] }),
      parseAlgorithms({ Algorithms: ['md5', 'sha256'] })
    );
  });

  it('prefers Algorithms over Algorithm when both are given', () => {
    assert.deepEqual(parseAlgorithms({ Algorithm: 'md5', Algorithms: ['sha1'] }), ['sha1']);
  });

  it('rejects unsupported and empty requests', () => {
    assert.throws(() => parseAlgorithms({ Algorithm: 'crc32' }), /unsupported algorithm/);
    assert.throws(() => parseAlgorithms({ Algorithms: [] }), /at least one/);
  });
});

describe('parseExpected', () => {
  it('treats a bare string as the sole requested algorithm', () => {
    assert.deepEqual(parseExpected(MD5, ['md5']), { md5: MD5 });
  });

  it('refuses a bare string when the algorithm is ambiguous', () => {
    assert.throws(() => parseExpected(MD5, ['md5', 'sha256']), /keyed by algorithm/);
  });

  it('normalizes case and whitespace', () => {
    assert.deepEqual(parseExpected({ MD5: ` ${MD5.toUpperCase()} ` }, ['md5']), { md5: MD5 });
  });

  it('rejects a digest of the wrong length', () => {
    assert.throws(() => parseExpected({ sha256: MD5 }, ['sha256']), /64 hex characters/);
  });

  it('rejects non-hex digests', () => {
    assert.throws(() => parseExpected({ md5: 'z'.repeat(32) }, ['md5']), /hex characters/);
  });

  it('rejects a digest for an algorithm that was not requested', () => {
    assert.throws(() => parseExpected({ sha256: SHA256 }, ['md5']), /not among the requested/);
  });

  it('treats absent values as no reference at all', () => {
    assert.deepEqual(parseExpected(undefined, ['md5']), {});
    assert.deepEqual(parseExpected('', ['md5']), {});
  });
});

describe('normalizeRequest', () => {
  it('fills in the defaults', () => {
    assert.deepEqual(normalizeRequest({ Bucket: 'b', Key: 'k' }), {
      Bucket: 'b',
      Key: 'k',
      Algorithms: ['md5'],
      StoreChecksumOnTagging: true,
      ChunkSize: DEFAULT_CHUNK_SIZE,
      RestoreRequest: { Days: 1, Tier: 'Bulk' },
    });
  });

  it('requires Bucket and Key', () => {
    assert.throws(() => normalizeRequest({ Key: 'k' }), /missing Bucket/);
    assert.throws(() => normalizeRequest({}), /missing Bucket, Key/);
  });

  it('honours an explicit opt-out of tagging', () => {
    assert.equal(normalizeRequest({ Bucket: 'b', Key: 'k', StoreChecksumOnTagging: false }).StoreChecksumOnTagging, false);
  });

  it('validates ChunkSize and RestoreRequest', () => {
    assert.throws(() => normalizeRequest({ Bucket: 'b', Key: 'k', ChunkSize: -1 }), /ChunkSize/);
    assert.throws(() => normalizeRequest({ Bucket: 'b', Key: 'k', ChunkSize: 'big' }), /ChunkSize/);
    assert.throws(() => normalizeRequest({ Bucket: 'b', Key: 'k', RestoreRequest: { Tier: 'Turbo' } }), /Tier/);
    assert.throws(() => normalizeRequest({ Bucket: 'b', Key: 'k', RestoreRequest: [] }), /must be an object/);
  });

  it('drops fields it does not recognize', () => {
    const normalized = normalizeRequest({ Bucket: 'b', Key: 'k', VendorRole: 'arn:aws:iam::111111111111:role/Read' });
    assert.ok(!('VendorRole' in normalized), 'only known fields reach the state machine');
  });
});

describe('FixityState', () => {
  it('reports STARTED on entry and IN_PROGRESS on re-entry', () => {
    const first = new FixityState('ComputeChecksum', { Bucket: 'b', Key: 'k', State: 'CheckRestoreStatus', Status: 'COMPLETED' });
    assert.equal(first.status, 'STARTED');

    const second = new FixityState('ComputeChecksum', { Bucket: 'b', Key: 'k', State: 'ComputeChecksum', Status: 'STARTED' });
    assert.equal(second.status, 'IN_PROGRESS');

    const third = new FixityState('ComputeChecksum', { Bucket: 'b', Key: 'k', State: 'ComputeChecksum', Status: 'IN_PROGRESS' });
    assert.equal(third.status, 'IN_PROGRESS');
  });

  it('accumulates elapsed time across invocations', () => {
    const state = new FixityState('ComputeChecksum', { Bucket: 'b', Key: 'k', Elapsed: 5000 });
    assert.ok(state.responseData().Elapsed >= 5000);
  });

  it('carries unknown payload keys forward and drops nulls', () => {
    const state = new FixityState('ComputeChecksum', { Bucket: 'b', Key: 'k', Custom: 'keep-me' });
    const response = state.responseData({ Dropped: undefined, Kept: 1 });
    assert.equal(response.Custom, 'keep-me');
    assert.equal(response.Kept, 1);
    assert.ok(!('Dropped' in response));
  });

  it('requires an object to work on', () => {
    assert.throws(() => new FixityState('ComputeChecksum', { Key: 'k' }), /missing Bucket/);
    assert.throws(() => new FixityState('', { Bucket: 'b', Key: 'k' }), /missing state name/);
  });
});
