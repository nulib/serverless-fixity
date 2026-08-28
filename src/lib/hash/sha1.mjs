// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  BlockHash,
  rotl,
} from './blockHash.mjs';

export class Sha1 extends BlockHash {
  static algorithm = 'sha1';

  static digestSize = 20;

  static initialState = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];

  constructor() {
    super();
    this.schedule = new Int32Array(80);
  }

  compress(buf, offset) {
    const w = this.schedule;
    for (let i = 0; i < 16; i += 1) {
      w[i] = buf.readInt32BE(offset + (i * 4));
    }
    for (let i = 16; i < 80; i += 1) {
      w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }

    let [a, b, c, d, e] = this.state;

    for (let i = 0; i < 80; i += 1) {
      let f;
      let k;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc | 0;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6 | 0;
      }

      const tmp = (rotl(a, 5) + f + e + k + w[i]) | 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = tmp;
    }

    this.state[0] = (this.state[0] + a) | 0;
    this.state[1] = (this.state[1] + b) | 0;
    this.state[2] = (this.state[2] + c) | 0;
    this.state[3] = (this.state[3] + d) | 0;
    this.state[4] = (this.state[4] + e) | 0;
  }
}
