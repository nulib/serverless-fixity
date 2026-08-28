// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  Readable,
} from 'node:stream';

/**
 * A stand-in for an S3Client that answers from a fixture and records what it
 * was asked. Commands are matched by constructor name, which is how the real
 * client dispatches them too.
 */
export class FakeS3 {
  /**
   * @param {object} responses operation name without the `Command` suffix
   *   (e.g. `GetObject`) -> response object, a function of the command input,
   *   or an Error to throw
   */
  constructor(responses = {}) {
    this.responses = responses;
    this.calls = [];
  }

  async send(command) {
    const name = command.constructor.name.replace(/Command$/, '');
    this.calls.push({ name, input: command.input });

    const handler = this.responses[name];
    if (handler === undefined) {
      throw Object.assign(new Error(`FakeS3: unexpected ${name}`), { name: 'NotImplemented' });
    }
    if (handler instanceof Error) {
      throw handler;
    }
    return typeof handler === 'function' ? handler(command.input) : handler;
  }

  callsTo(name) {
    return this.calls.filter((call) => call.name === name);
  }
}

/** Serve `body` for a GetObject, honouring the requested byte range. */
export function rangedObject(body, { chunkSize = 8192 } = {}) {
  return ({ Range }) => {
    const matched = /^bytes=(\d+)-(\d+)$/.exec(Range ?? '');
    const slice = matched
      ? body.subarray(Number(matched[1]), Number(matched[2]) + 1)
      : body;

    const chunks = [];
    for (let at = 0; at < slice.length; at += chunkSize) {
      chunks.push(slice.subarray(at, at + chunkSize));
    }
    return {
      ContentLength: slice.length,
      Body: Readable.from(chunks),
    };
  };
}
