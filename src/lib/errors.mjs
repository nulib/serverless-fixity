// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The class names double as Step Functions error identifiers -- the state
 * machine matches on them in its Retry blocks -- so renaming one is a
 * breaking change to statemachine/fixity.asl.json.
 */

class FixityError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = new.target.name;
    this.code = this.name;
    this.statusCode = new.target.statusCode;
  }
}

/** Anything that went wrong while computing a checksum. */
export class ChecksumError extends FixityError {
  static statusCode = 1000;
}

export class NotImplementedError extends FixityError {
  static statusCode = 1001;
}

export class InvalidArgumentError extends FixityError {
  static statusCode = 1002;
}

export class ConfigurationError extends FixityError {
  static statusCode = 1005;
}

/** The object changed underneath us -- the run is no longer meaningful. */
export class MismatchETagError extends FixityError {
  static statusCode = 1007;
}

export class MismatchFileSizeError extends FixityError {
  static statusCode = 1008;
}

/** Never retried: more attempts cannot conjure up permission. */
export class ForbiddenError extends FixityError {
  static statusCode = 403;
}

const FORBIDDEN_CODES = new Set(['AccessDenied', 'AllAccessDisabled', 'InvalidAccessKeyId', 'SignatureDoesNotMatch']);

/**
 * Normalize whatever surfaced into one of our errors so the state machine can
 * tell "stop now" apart from "worth another try".
 */
export function toFixityError(error) {
  if (error instanceof FixityError) {
    return error;
  }

  const status = error?.$metadata?.httpStatusCode ?? error?.statusCode;
  if (status === 403 || FORBIDDEN_CODES.has(error?.name) || FORBIDDEN_CODES.has(error?.Code)) {
    return new ForbiddenError(error?.message ?? 'forbidden', { cause: error });
  }

  return new ChecksumError(error?.message ?? String(error), { cause: error });
}
