// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  createHash,
} from 'node:crypto';

import {
  Md5,
} from './md5.mjs';

import {
  Sha1,
} from './sha1.mjs';

import {
  Sha256,
} from './sha256.mjs';

const IMPLEMENTATIONS = new Map([
  [Md5.algorithm, Md5],
  [Sha1.algorithm, Sha1],
  [Sha256.algorithm, Sha256],
]);

export const SUPPORTED_ALGORITHMS = [...IMPLEMENTATIONS.keys()];

export const DEFAULT_ALGORITHM = Md5.algorithm;

/** hex digest length of each algorithm, used to sanity check supplied checksums */
export const DIGEST_HEX_LENGTH = Object.fromEntries(
  [...IMPLEMENTATIONS].map(([name, Impl]) => [name, Impl.digestSize * 2])
);

export function isSupportedAlgorithm(name) {
  return IMPLEMENTATIONS.has(String(name).toLowerCase());
}

/**
 * Wraps node:crypto so it presents the same face as our resumable hashes. It
 * is markedly faster, so we use it whenever an object is small enough to be
 * hashed within a single invocation and no state ever has to be carried over.
 */
class NativeHash {
  constructor(algorithm) {
    this.algorithm = algorithm;
    this.hash = createHash(algorithm);
  }

  update(chunk) {
    this.hash.update(chunk);
    return this;
  }

  digest(encoding = 'hex') {
    return this.hash.digest(encoding);
  }

   
  serialize() {
    throw new Error('a native hash cannot be suspended; construct with resumable: true');
  }
}

/**
 * A bundle of hashes fed from one byte stream.
 *
 * This is what makes multi-algorithm fixity cheap: the object is read from S3
 * exactly once no matter how many digests are requested, because every chunk
 * is handed to every hash before the next chunk arrives.
 */
export class ChecksumSet {
  constructor(hashes) {
    this.hashes = hashes;
  }

  get algorithms() {
    return this.hashes.map((hash) => hash.algorithm);
  }

  /**
   * @param {string[]} algorithms
   * @param {object}   [options]
   * @param {boolean}  [options.resumable] false lets us use node:crypto, which
   *   is only safe when the digests will be finalized in this same invocation.
   */
  static create(algorithms, { resumable = true } = {}) {
    const hashes = algorithms.map((name) => {
      const Impl = IMPLEMENTATIONS.get(name);
      if (!Impl) {
        throw new Error(`unsupported algorithm: ${name}`);
      }
      return resumable ? new Impl() : new NativeHash(name);
    });
    return new ChecksumSet(hashes);
  }

  /**
   * Rebuild a set that was suspended mid-object.
   * @param {Record<string, string>} tokens algorithm name -> serialized state
   */
  static restore(tokens) {
    const hashes = Object.entries(tokens).map(([name, token]) => {
      const Impl = IMPLEMENTATIONS.get(name);
      if (!Impl) {
        throw new Error(`unsupported algorithm: ${name}`);
      }
      return Impl.deserialize(token);
    });
    return new ChecksumSet(hashes);
  }

  update(chunk) {
    for (const hash of this.hashes) {
      hash.update(chunk);
    }
    return this;
  }

  /** @returns {Record<string, string>} algorithm name -> serialized state */
  serialize() {
    return Object.fromEntries(this.hashes.map((hash) => [hash.algorithm, hash.serialize()]));
  }

  /** @returns {Record<string, string>} algorithm name -> lowercase hex digest */
  digest() {
    return Object.fromEntries(this.hashes.map((hash) => [hash.algorithm, hash.digest('hex')]));
  }
}

export {
  Md5,
  Sha1,
  Sha256,
};
