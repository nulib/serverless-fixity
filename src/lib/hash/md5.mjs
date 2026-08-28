// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  BlockHash,
  rotl,
} from './blockHash.mjs';

/* per-round shift amounts, four per round, indexed by (round, i mod 4) */
const SHIFTS = [
  7, 12, 17, 22,
  5, 9, 14, 20,
  4, 11, 16, 23,
  6, 10, 15, 21,
];

/* K[i] = floor(abs(sin(i + 1)) * 2^32) */
const K = Int32Array.from(
  { length: 64 },
  (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) | 0
);

export class Md5 extends BlockHash {
  static algorithm = 'md5';

  static digestSize = 16;

  static endian = 'LE';

  static initialState = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];

  compress(buf, offset) {
    const m = this.words;
    for (let i = 0; i < 16; i += 1) {
      m[i] = buf.readInt32LE(offset + (i * 4));
    }

    let [a, b, c, d] = this.state;

    for (let i = 0; i < 64; i += 1) {
      let f;
      let g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = ((5 * i) + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = ((3 * i) + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }

      const tmp = d;
      d = c;
      c = b;
      const sum = (f + a + K[i] + m[g]) | 0;
      b = (b + rotl(sum, SHIFTS[((i >> 4) * 4) + (i % 4)])) | 0;
      a = tmp;
    }

    this.state[0] = (this.state[0] + a) | 0;
    this.state[1] = (this.state[1] + b) | 0;
    this.state[2] = (this.state[2] + c) | 0;
    this.state[3] = (this.state[3] + d) | 0;
  }
}
