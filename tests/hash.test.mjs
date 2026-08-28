// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  ChecksumSet,
  DIGEST_HEX_LENGTH,
  SUPPORTED_ALGORITHMS,
} from '../src/lib/hash/index.mjs';

const reference = (algorithm, buffers) => {
  const hash = createHash(algorithm);
  for (const buf of buffers) {
    hash.update(buf);
  }
  return hash.digest('hex');
};

/* sizes that bracket the interesting cases: empty, sub-block, exactly one
 * block, the two padding-block boundaries (55/56 mod 64), and multi-block */
const SIZES = [0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 1000, 65536, 200000];

describe('resumable hashes', () => {
  for (const algorithm of SUPPORTED_ALGORITHMS) {
    describe(algorithm, () => {
      it('matches node:crypto across block boundaries', () => {
        for (const size of SIZES) {
          const data = randomBytes(size);
          const set = ChecksumSet.create([algorithm]);
          set.update(data);
          assert.equal(set.digest()[algorithm], reference(algorithm, [data]), `size ${size}`);
        }
      });

      it('matches node:crypto when fed in ragged chunks', () => {
        const data = randomBytes(300000);
        const chunks = [];
        for (let at = 0; at < data.length;) {
          const take = Math.min(1 + Math.floor(Math.random() * 4096), data.length - at);
          chunks.push(data.subarray(at, at + take));
          at += take;
        }
        const set = ChecksumSet.create([algorithm]);
        for (const chunk of chunks) {
          set.update(chunk);
        }
        assert.equal(set.digest()[algorithm], reference(algorithm, chunks));
      });

      it('survives a serialize/deserialize round trip at every offset', () => {
        const data = randomBytes(1024);
        for (const split of [0, 1, 63, 64, 65, 127, 128, 500, 1023, 1024]) {
          let set = ChecksumSet.create([algorithm]);
          set.update(data.subarray(0, split));
          set = ChecksumSet.restore(set.serialize());
          set.update(data.subarray(split));
          assert.equal(set.digest()[algorithm], reference(algorithm, [data]), `split ${split}`);
        }
      });

      it('survives many consecutive suspensions', () => {
        const data = randomBytes(10000);
        let set = ChecksumSet.create([algorithm]);
        for (let at = 0; at < data.length; at += 333) {
          set.update(data.subarray(at, at + 333));
          set = ChecksumSet.restore(set.serialize());
        }
        assert.equal(set.digest()[algorithm], reference(algorithm, [data]));
      });

      it('reports the documented digest length', () => {
        const set = ChecksumSet.create([algorithm]);
        assert.equal(set.digest()[algorithm].length, DIGEST_HEX_LENGTH[algorithm]);
      });
    });
  }

  it('computes every algorithm from a single pass over the bytes', () => {
    const data = randomBytes(150000);
    const set = ChecksumSet.create(SUPPORTED_ALGORITHMS);
    set.update(data.subarray(0, 70000));
    const resumed = ChecksumSet.restore(set.serialize());
    resumed.update(data.subarray(70000));

    const digests = resumed.digest();
    assert.deepEqual(Object.keys(digests).sort(), [...SUPPORTED_ALGORITHMS].sort());
    for (const algorithm of SUPPORTED_ALGORITHMS) {
      assert.equal(digests[algorithm], reference(algorithm, [data]), algorithm);
    }
  });

  it('agrees with the non-resumable node:crypto fast path', () => {
    const data = randomBytes(100000);
    const native = ChecksumSet.create(SUPPORTED_ALGORITHMS, { resumable: false });
    const portable = ChecksumSet.create(SUPPORTED_ALGORITHMS);
    native.update(data);
    portable.update(data);
    assert.deepEqual(native.digest(), portable.digest());
  });

  it('refuses to suspend a native hash', () => {
    const native = ChecksumSet.create(['md5'], { resumable: false });
    assert.throws(() => native.serialize(), /cannot be suspended/);
  });

  it('rejects a state token from a different algorithm', () => {
    const set = ChecksumSet.create(['md5']);
    const token = set.serialize().md5;
    assert.throws(() => ChecksumSet.restore({ sha256: token }), /hash state is for md5/);
  });

  it('rejects an unknown algorithm', () => {
    assert.throws(() => ChecksumSet.create(['crc32']), /unsupported algorithm/);
  });
});
