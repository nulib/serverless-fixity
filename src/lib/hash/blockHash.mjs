// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Common machinery for the resumable block hashes.
 *
 * Every algorithm we support (MD5, SHA-1, SHA-256) is a Merkle-Damgard
 * construction over 64-byte blocks, so they only differ in three things: the
 * chaining state, the compression function, and the byte order used for the
 * length suffix and the final digest.
 *
 * Being able to freeze and thaw that state is the whole point of this module:
 * a fixity run spans many Lambda invocations, so the state travels through the
 * Step Functions payload between them.
 */

const BLOCK_SIZE = 64;
const SERIAL_VERSION = 1;

export class BlockHash {
  /** @type {string} algorithm name, e.g. 'sha256' */
  static algorithm;

  /** @type {number} digest size in bytes */
  static digestSize;

  /** @type {'BE' | 'LE'} byte order of the length suffix and the digest words */
  static endian = 'BE';

  /** @type {number[]} initial chaining state, as unsigned 32-bit words */
  static initialState;

  constructor() {
    this.state = Int32Array.from(new.target.initialState, (word) => word | 0);
    this.tail = Buffer.alloc(BLOCK_SIZE);
    this.tailLength = 0;
    /* total number of bytes consumed; hashes are capped well below 2^53 bytes */
    this.byteLength = 0;
    this.words = new Int32Array(16);
    this.finalized = false;
  }

  get algorithm() {
    return this.constructor.algorithm;
  }

  /**
   * Absorb a chunk. Full blocks are compressed in place, straight out of the
   * caller's buffer, so a stream chunk is never copied unless it straddles a
   * block boundary.
   */
  update(data) {
    if (this.finalized) {
      throw new Error(`${this.algorithm}: update() after digest()`);
    }

    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this.byteLength += buf.length;

    let offset = 0;

    if (this.tailLength > 0) {
      const wanted = BLOCK_SIZE - this.tailLength;
      if (buf.length < wanted) {
        buf.copy(this.tail, this.tailLength);
        this.tailLength += buf.length;
        return this;
      }
      buf.copy(this.tail, this.tailLength, 0, wanted);
      this.compress(this.tail, 0);
      this.tailLength = 0;
      offset = wanted;
    }

    for (; offset + BLOCK_SIZE <= buf.length; offset += BLOCK_SIZE) {
      this.compress(buf, offset);
    }

    if (offset < buf.length) {
      buf.copy(this.tail, 0, offset);
      this.tailLength = buf.length - offset;
    }

    return this;
  }

  /**
   * Pad, compress the final block(s), and render the digest. The instance is
   * spent afterwards.
   */
  digest(encoding = 'hex') {
    if (this.finalized) {
      throw new Error(`${this.algorithm}: digest() called twice`);
    }
    this.finalized = true;

    const {
      digestSize,
      endian,
    } = this.constructor;

    /* 0x80, then zeroes, then a 64-bit bit-count: one block, or two if the
     * length no longer fits after the 0x80 marker */
    const padded = Buffer.alloc(this.tailLength < 56 ? BLOCK_SIZE : BLOCK_SIZE * 2);
    this.tail.copy(padded, 0, 0, this.tailLength);
    padded[this.tailLength] = 0x80;

    const bits = this.byteLength * 8;
    /* split by hand: bit counts above 2^32 exceed what writeUInt32 accepts */
    const lo = bits % 0x100000000;
    const hi = Math.floor(bits / 0x100000000);
    if (endian === 'LE') {
      padded.writeUInt32LE(lo, padded.length - 8);
      padded.writeUInt32LE(hi, padded.length - 4);
    } else {
      padded.writeUInt32BE(hi, padded.length - 8);
      padded.writeUInt32BE(lo, padded.length - 4);
    }

    for (let offset = 0; offset < padded.length; offset += BLOCK_SIZE) {
      this.compress(padded, offset);
    }

    const out = Buffer.alloc(digestSize);
    for (let i = 0; i < digestSize / 4; i += 1) {
      if (endian === 'LE') {
        out.writeInt32LE(this.state[i], i * 4);
      } else {
        out.writeInt32BE(this.state[i], i * 4);
      }
    }
    return encoding === 'buffer' ? out : out.toString(encoding);
  }

  /**
   * Freeze the mid-stream state into a compact, self-describing token.
   *
   * Layout: version | name length | name | byteLength (BE 64-bit) |
   *         chaining words (BE 32-bit) | tail length | tail bytes
   */
  serialize() {
    if (this.finalized) {
      throw new Error(`${this.algorithm}: cannot serialize a finalized hash`);
    }

    const name = Buffer.from(this.algorithm, 'utf8');
    const out = Buffer.alloc(2 + name.length + 8 + this.state.length * 4 + 1 + this.tailLength);

    let at = 0;
    out.writeUInt8(SERIAL_VERSION, at); at += 1;
    out.writeUInt8(name.length, at); at += 1;
    name.copy(out, at); at += name.length;
    out.writeUInt32BE(Math.floor(this.byteLength / 0x100000000), at); at += 4;
    out.writeUInt32BE(this.byteLength % 0x100000000, at); at += 4;
    for (const word of this.state) {
      out.writeInt32BE(word, at); at += 4;
    }
    out.writeUInt8(this.tailLength, at); at += 1;
    this.tail.copy(out, at, 0, this.tailLength);

    return out.toString('base64');
  }

  /** Thaw a token produced by {@link BlockHash#serialize}. */
  static deserialize(token) {
    const buf = Buffer.from(token, 'base64');

    let at = 0;
    const version = buf.readUInt8(at); at += 1;
    if (version !== SERIAL_VERSION) {
      throw new Error(`unsupported hash state version ${version}`);
    }
    const nameLength = buf.readUInt8(at); at += 1;
    const name = buf.toString('utf8', at, at + nameLength); at += nameLength;
    if (name !== this.algorithm) {
      throw new Error(`hash state is for ${name}, not ${this.algorithm}`);
    }

    const hash = new this();
    const hi = buf.readUInt32BE(at); at += 4;
    const lo = buf.readUInt32BE(at); at += 4;
    hash.byteLength = (hi * 0x100000000) + lo;
    for (let i = 0; i < hash.state.length; i += 1) {
      hash.state[i] = buf.readInt32BE(at); at += 4;
    }
    hash.tailLength = buf.readUInt8(at); at += 1;
    buf.copy(hash.tail, 0, at, at + hash.tailLength);

    return hash;
  }

   
  compress() {
    throw new Error('subclass must implement compress()');
  }
}

export const rotl = (x, n) => (x << n) | (x >>> (32 - n));
export const rotr = (x, n) => (x >>> n) | (x << (32 - n));

export { BLOCK_SIZE };
