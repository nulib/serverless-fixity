// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ChecksumValidation,
  overallResult,
} from '../src/lib/validate.mjs';

import {
  FakeS3,
} from './helpers/fakeS3.mjs';

const MD5 = 'd41d8cd98f00b204e9800998ecf8427e';
const OTHER_MD5 = '0cc175b9c0f1b6a831c399e269772661';
const SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const payload = (overrides = {}) => ({
  Bucket: 'preservation',
  Key: 'masters/reel-1.mov',
  Algorithms: ['md5', 'sha256'],
  Computed: { md5: MD5, sha256: SHA256 },
  FileSize: 1024,
  ...overrides,
});

const taggedWith = (TagSet, head = {}) => new FakeS3({
  GetObjectTagging: { TagSet },
  PutObjectTagging: {},
  HeadObject: { Metadata: {}, ...head },
});

describe('ChecksumValidation', () => {
  it('compares each algorithm against the value supplied by the caller', async () => {
    const s3 = taggedWith([]);
    const response = await new ChecksumValidation(payload({
      Expected: { md5: MD5, sha256: SHA256 },
    }), { s3 }).run();

    assert.equal(response.ComparedResult, 'MATCHED');
    assert.equal(response.Checksums.md5.ComparedWith, 'api');
    assert.equal(response.Checksums.md5.ComparedResult, 'MATCHED');
    assert.equal(response.Checksums.sha256.ComparedResult, 'MATCHED');
    assert.equal(response.Status, 'COMPLETED');
  });

  it('judges each algorithm independently', async () => {
    const s3 = taggedWith([]);
    const response = await new ChecksumValidation(payload({
      Expected: { md5: OTHER_MD5, sha256: SHA256 },
    }), { s3 }).run();

    assert.equal(response.Checksums.md5.ComparedResult, 'NOTMATCHED');
    assert.equal(response.Checksums.sha256.ComparedResult, 'MATCHED');
    /* one bad digest condemns the run */
    assert.equal(response.ComparedResult, 'NOTMATCHED');
  });

  it('reports SKIPPED when there is nothing to compare against', async () => {
    const s3 = taggedWith([], { ETag: '"abc-2"' });
    const response = await new ChecksumValidation(payload(), { s3 }).run();

    assert.equal(response.ComparedResult, 'SKIPPED');
    assert.equal(response.Checksums.md5.ComparedWith, 'none');
    assert.ok(!('Expected' in response.Checksums.md5));
  });

  it('prefers an existing tag over object metadata', async () => {
    const s3 = taggedWith(
      [{ Key: 'computed-md5', Value: MD5 }],
      { Metadata: { md5: OTHER_MD5 } }
    );
    const response = await new ChecksumValidation(payload({ Algorithms: ['md5'], Computed: { md5: MD5 } }), { s3 }).run();

    assert.equal(response.Checksums.md5.ComparedWith, 'object-tagging');
    assert.equal(response.Checksums.md5.ComparedResult, 'MATCHED');
  });

  it('falls back to x-amz-meta-<algorithm>', async () => {
    const s3 = taggedWith([], { Metadata: { sha256: SHA256 } });
    const response = await new ChecksumValidation(payload({ Algorithms: ['sha256'], Computed: { sha256: SHA256 } }), { s3 }).run();

    assert.equal(response.Checksums.sha256.ComparedWith, 'object-metadata');
    assert.equal(response.Checksums.sha256.ComparedResult, 'MATCHED');
  });

  it('uses the ETag as a last resort, but only for single-part unencrypted MD5', async () => {
    const single = taggedWith([], { ETag: `"${MD5}"` });
    const response = await new ChecksumValidation(payload({ Algorithms: ['md5'], Computed: { md5: MD5 } }), { s3: single }).run();
    assert.equal(response.Checksums.md5.ComparedWith, 'object-etag');

    /* a multipart ETag is not an MD5 of the object */
    const multipart = taggedWith([], { ETag: `"${MD5}-4"` });
    const fromMultipart = await new ChecksumValidation(payload({ Algorithms: ['md5'], Computed: { md5: MD5 } }), { s3: multipart }).run();
    assert.equal(fromMultipart.Checksums.md5.ComparedWith, 'none');

    /* nor is it under KMS encryption */
    const kms = taggedWith([], { ETag: `"${MD5}"`, ServerSideEncryption: 'aws:kms' });
    const fromKms = await new ChecksumValidation(payload({ Algorithms: ['md5'], Computed: { md5: MD5 } }), { s3: kms }).run();
    assert.equal(fromKms.Checksums.md5.ComparedWith, 'none');
  });

  it('never treats an ETag as a SHA-256', async () => {
    const s3 = taggedWith([], { ETag: `"${MD5}"` });
    const response = await new ChecksumValidation(payload({ Algorithms: ['sha256'], Computed: { sha256: SHA256 } }), { s3 }).run();
    assert.equal(response.Checksums.sha256.ComparedWith, 'none');
  });

  it('ignores a malformed checksum tag', async () => {
    const s3 = taggedWith([{ Key: 'computed-md5', Value: 'not-a-digest' }], { ETag: '"x-2"' });
    const response = await new ChecksumValidation(payload({ Algorithms: ['md5'], Computed: { md5: MD5 } }), { s3 }).run();
    assert.equal(response.Checksums.md5.ComparedWith, 'none');
  });

  it('writes one tag pair per algorithm and preserves unrelated tags', async () => {
    const s3 = taggedWith([{ Key: 'project', Value: 'archive' }], { ETag: '"x-2"' });
    const response = await new ChecksumValidation(payload(), { s3 }).run();

    const { TagSet } = s3.callsTo('PutObjectTagging')[0].input.Tagging;
    const keys = TagSet.map((tag) => tag.Key);
    assert.deepEqual(keys, [
      'project',
      'computed-md5', 'computed-md5-last-modified',
      'computed-sha256', 'computed-sha256-last-modified',
    ]);
    assert.equal(TagSet.find((tag) => tag.Key === 'computed-sha256').Value, SHA256);
    assert.equal(response.Checksums.md5.TagUpdated, true);
    assert.equal(response.Checksums.sha256.TagUpdated, true);
  });

  it('replaces its own stale tags rather than duplicating them', async () => {
    const s3 = taggedWith([
      { Key: 'computed-md5', Value: OTHER_MD5 },
      { Key: 'computed-md5-last-modified', Value: '1' },
    ], { ETag: '"x-2"' });

    await new ChecksumValidation(payload({
      Algorithms: ['md5'],
      Computed: { md5: MD5 },
      Expected: { md5: MD5 },
    }), { s3 }).run();

    const { TagSet } = s3.callsTo('PutObjectTagging')[0].input.Tagging;
    assert.equal(TagSet.filter((tag) => tag.Key === 'computed-md5').length, 1);
    assert.equal(TagSet.find((tag) => tag.Key === 'computed-md5').Value, MD5);
  });

  it('does not record a digest that failed its comparison', async () => {
    const s3 = taggedWith([], { ETag: '"x-2"' });
    const response = await new ChecksumValidation(payload({
      Expected: { md5: OTHER_MD5, sha256: SHA256 },
    }), { s3 }).run();

    assert.equal(response.Checksums.md5.TagUpdated, false);
    const keys = s3.callsTo('PutObjectTagging')[0].input.Tagging.TagSet.map((tag) => tag.Key);
    assert.ok(!keys.includes('computed-md5'));
    assert.ok(keys.includes('computed-sha256'));
  });

  it('skips tagging entirely when asked to', async () => {
    const s3 = taggedWith([], { ETag: '"x-2"' });
    await new ChecksumValidation(payload({ StoreChecksumOnTagging: false }), { s3 }).run();
    assert.equal(s3.callsTo('PutObjectTagging').length, 0);
  });

  it('leaves room for tags it cannot fit and says so', async () => {
    const crowded = Array.from({ length: 9 }, (_, i) => ({ Key: `tag-${i}`, Value: 'v' }));
    const s3 = taggedWith(crowded, { ETag: '"x-2"' });
    const response = await new ChecksumValidation(payload(), { s3 }).run();

    /* only one pair fits under S3's ten-tag ceiling */
    assert.equal(response.Checksums.md5.TagUpdated, false);
    assert.equal(response.Checksums.sha256.TagUpdated, false);
    assert.equal(s3.callsTo('PutObjectTagging').length, 0);
    /* the comparison still stands */
    assert.equal(response.Status, 'COMPLETED');
  });

  it('reports the comparison even if tagging is denied', async () => {
    const s3 = new FakeS3({
      GetObjectTagging: { TagSet: [] },
      HeadObject: { Metadata: {}, ETag: '"x-2"' },
      PutObjectTagging: Object.assign(new Error('denied'), { name: 'AccessDenied' }),
    });

    const response = await new ChecksumValidation(payload({
      Expected: { md5: MD5, sha256: SHA256 },
    }), { s3 }).run();

    assert.equal(response.ComparedResult, 'MATCHED');
    assert.equal(response.Checksums.md5.TagUpdated, false);
  });

  it('tolerates being unable to read tags', async () => {
    const s3 = new FakeS3({
      GetObjectTagging: Object.assign(new Error('denied'), { name: 'AccessDenied' }),
      HeadObject: { Metadata: {}, ETag: '"x-2"' },
      PutObjectTagging: {},
    });
    const response = await new ChecksumValidation(payload(), { s3 }).run();
    assert.equal(response.ComparedResult, 'SKIPPED');
  });

  it('clears the compute state from its response', async () => {
    const s3 = taggedWith([], { ETag: '"x-2"' });
    const response = await new ChecksumValidation(payload({
      IntermediateHashes: { md5: 'stale' },
      BytesRead: 1024,
      ForceResumable: true,
    }), { s3 }).run();

    for (const key of ['IntermediateHashes', 'BytesRead', 'ForceResumable', 'Computed']) {
      assert.ok(!(key in response), `${key} should not survive into the final report`);
    }
  });

  it('insists on having something to validate', () => {
    assert.throws(() => new ChecksumValidation({ Bucket: 'b', Key: 'k' }), /missing Computed/);
    assert.throws(
      () => new ChecksumValidation({ Bucket: 'b', Key: 'k', Algorithms: ['md5', 'sha1'], Computed: { md5: MD5 } }),
      /missing computed checksum\(s\) for sha1/
    );
  });
});

describe('overallResult', () => {
  it('takes the worst verdict of the set', () => {
    assert.equal(overallResult({ a: { ComparedResult: 'MATCHED' }, b: { ComparedResult: 'SKIPPED' } }), 'MATCHED');
    assert.equal(overallResult({ a: { ComparedResult: 'MATCHED' }, b: { ComparedResult: 'NOTMATCHED' } }), 'NOTMATCHED');
    assert.equal(overallResult({ a: { ComparedResult: 'SKIPPED' } }), 'SKIPPED');
  });
});
