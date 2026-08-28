// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  DEFAULT_ALGORITHM,
  DIGEST_HEX_LENGTH,
  isSupportedAlgorithm,
  SUPPORTED_ALGORITHMS,
} from './hash/index.mjs';

import {
  InvalidArgumentError,
} from './errors.mjs';

/**
 * Upper bound on the bytes any single invocation will request from S3. The
 * invocation deadline usually cuts a chunk short well before this, so treat it
 * as a ceiling rather than a target.
 */
export const DEFAULT_CHUNK_SIZE = 20 * 1024 * 1024 * 1024;

export const RESTORE_TIERS = ['Standard', 'Bulk', 'Expedited'];

export const DEFAULT_RESTORE_DAYS = 1;

export const DEFAULT_RESTORE_TIER = 'Bulk';

const HEX = /^[0-9a-f]+$/;

/**
 * Accept both the single-algorithm spelling (`Algorithm: 'md5'`) and the
 * multi-algorithm one (`Algorithms: ['md5', 'sha256']`), and return the
 * de-duplicated, lowercased list in a stable order.
 */
export function parseAlgorithms({ Algorithm, Algorithms } = {}) {
  const requested = Algorithms ?? Algorithm ?? [DEFAULT_ALGORITHM];
  const list = (Array.isArray(requested) ? requested : String(requested).split(','))
    .map((name) => String(name).trim().toLowerCase())
    .filter((name) => name.length > 0);

  if (list.length === 0) {
    throw new InvalidArgumentError('Algorithms must name at least one algorithm');
  }

  const unsupported = list.filter((name) => !isSupportedAlgorithm(name));
  if (unsupported.length > 0) {
    throw new InvalidArgumentError(`unsupported algorithm(s): ${unsupported.join(', ')}. Supported: ${SUPPORTED_ALGORITHMS.join(', ')}`);
  }

  /* SUPPORTED_ALGORITHMS order keeps the payload stable across invocations */
  return SUPPORTED_ALGORITHMS.filter((name) => list.includes(name));
}

/**
 * Normalize the caller's reference checksums into an `{ algorithm: digest }`
 * map. A bare string is taken to mean the sole requested algorithm, which is
 * only unambiguous when exactly one was asked for.
 */
export function parseExpected(expected, algorithms) {
  if (expected === undefined || expected === null || expected === '') {
    return {};
  }

  let entries;
  if (typeof expected === 'string') {
    if (algorithms.length !== 1) {
      throw new InvalidArgumentError('Expected must be an object keyed by algorithm when more than one algorithm is requested');
    }
    entries = [[algorithms[0], expected]];
  } else if (typeof expected === 'object' && !Array.isArray(expected)) {
    entries = Object.entries(expected);
  } else {
    throw new InvalidArgumentError('Expected must be a string or an object keyed by algorithm');
  }

  const normalized = {};
  for (const [rawName, rawDigest] of entries) {
    const name = String(rawName).toLowerCase();
    if (!algorithms.includes(name)) {
      throw new InvalidArgumentError(`Expected names ${name}, which is not among the requested algorithms (${algorithms.join(', ')})`);
    }
    const digest = String(rawDigest).trim().toLowerCase();
    if (!HEX.test(digest) || digest.length !== DIGEST_HEX_LENGTH[name]) {
      throw new InvalidArgumentError(`Expected.${name} must be ${DIGEST_HEX_LENGTH[name]} hex characters`);
    }
    normalized[name] = digest;
  }
  return normalized;
}

function parseChunkSize(value) {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_CHUNK_SIZE;
  }
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new InvalidArgumentError('ChunkSize must be a positive integer number of bytes');
  }
  return size;
}

function parseRestoreRequest(value) {
  if (value === undefined || value === null) {
    return { Days: DEFAULT_RESTORE_DAYS, Tier: DEFAULT_RESTORE_TIER };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidArgumentError('RestoreRequest must be an object');
  }

  const days = value.Days === undefined ? DEFAULT_RESTORE_DAYS : Number(value.Days);
  if (!Number.isSafeInteger(days) || days <= 0) {
    throw new InvalidArgumentError('RestoreRequest.Days must be a positive integer');
  }

  const tier = value.Tier ?? DEFAULT_RESTORE_TIER;
  if (!RESTORE_TIERS.includes(tier)) {
    throw new InvalidArgumentError(`RestoreRequest.Tier must be one of ${RESTORE_TIERS.join(', ')}`);
  }

  return { Days: days, Tier: tier };
}

/**
 * Validate and canonicalize a fixity request. The result is the payload the
 * state machine starts with, and every state round-trips a superset of it.
 */
export function normalizeRequest(input = {}) {
  const missing = ['Bucket', 'Key'].filter((key) => !input[key]);
  if (missing.length > 0) {
    throw new InvalidArgumentError(`missing ${missing.join(', ')}`);
  }

  const algorithms = parseAlgorithms(input);
  const expected = parseExpected(input.Expected, algorithms);

  return {
    Bucket: input.Bucket,
    Key: input.Key,
    Algorithms: algorithms,
    ...(Object.keys(expected).length > 0 ? { Expected: expected } : {}),
    /* tagging is opt-out: preservation callers nearly always want the record */
    StoreChecksumOnTagging: input.StoreChecksumOnTagging !== false,
    ChunkSize: parseChunkSize(input.ChunkSize),
    RestoreRequest: parseRestoreRequest(input.RestoreRequest),
  };
}

/**
 * The bookkeeping every state shares: which state we are in, how long the run
 * has taken so far, and the object identity we pinned on the first look.
 *
 * `Status` is derived rather than passed in. Entering a state for the first
 * time is STARTED; coming back around to the same state is IN_PROGRESS; a
 * state declares COMPLETED itself when it is done.
 */
export class FixityState {
  constructor(stateName, payload = {}) {
    if (!stateName) {
      throw new InvalidArgumentError('missing state name');
    }
    const missing = ['Bucket', 'Key'].filter((key) => payload[key] === undefined);
    if (missing.length > 0) {
      throw new InvalidArgumentError(`missing ${missing.join(', ')}`);
    }

    this.payload = payload;
    this.stateName = stateName;
    this.bucket = payload.Bucket;
    this.key = payload.Key;
    this.etag = payload.ETag;
    this.fileSize = payload.FileSize === undefined ? undefined : Number(payload.FileSize);
    this.algorithms = parseAlgorithms(payload);
    this.expected = parseExpected(payload.Expected, this.algorithms);

    if (payload.State !== stateName) {
      this.status = 'STARTED';
    } else if (payload.Status === 'STARTED') {
      this.status = 'IN_PROGRESS';
    } else {
      this.status = payload.Status ?? 'STARTED';
    }

    this.priorElapsed = Number(payload.Elapsed ?? 0);
    this.startedAt = Date.now();
  }

  get elapsed() {
    return this.priorElapsed + (Date.now() - this.startedAt);
  }

  /**
   * Carry the incoming payload forward with this state's updates layered on
   * top, dropping keys explicitly set to undefined.
   */
  responseData(updates = {}) {
    const merged = {
      ...this.payload,
      Bucket: this.bucket,
      Key: this.key,
      Algorithms: this.algorithms,
      ETag: this.etag,
      FileSize: this.fileSize,
      State: this.stateName,
      Status: this.status,
      ...updates,
      Elapsed: this.elapsed,
    };

    for (const [key, value] of Object.entries(merged)) {
      if (value === undefined || value === null) {
        delete merged[key];
      }
    }
    return merged;
  }
}
