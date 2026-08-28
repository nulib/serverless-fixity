// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Lambda entry points. One handler per Step Functions state, plus the API
 * facade. The work lives in ./lib -- these wrappers only translate between the
 * Lambda calling convention and the state classes.
 */

import {
  ApiRequest,
} from './lib/api.mjs';

import {
  ChecksumCompute,
} from './lib/compute.mjs';

import {
  ChecksumValidation,
} from './lib/validate.mjs';

import {
  S3Restore,
} from './lib/restore.mjs';

import {
  toFixityError,
} from './lib/errors.mjs';

/**
 * Run one state and log its boundaries. Errors are normalized so the state
 * machine can distinguish a permission problem, which no amount of retrying
 * will fix, from a transient one.
 */
async function runState(name, event, work) {
  console.log(`${name} <<<`, JSON.stringify(event));
  try {
    const response = await work();
    console.log(`${name} >>>`, JSON.stringify(response));
    return response;
  } catch (e) {
    const error = toFixityError(e);
    console.error(`${name} failed:`, error);
    throw error;
  }
}

/** API Gateway proxy handler for POST/GET /fixity. */
export const OnRequest = async (event, context) => runState(
  'OnRequest',
  event,
  () => new ApiRequest(event, context).request()
);

/** Pin the object's identity and, when archived, drive the restore. */
export const CheckRestoreStatus = async (event) => runState(
  'CheckRestoreStatus',
  event,
  () => new S3Restore(event).checkStatus()
);

/** Hash one range of the object with every requested algorithm. */
export const ComputeChecksum = async (event, context) => runState(
  'ComputeChecksum',
  event,
  () => new ChecksumCompute(event, {
    remainingTimeInMillis: () => context.getRemainingTimeInMillis(),
  }).compute()
);

/** Compare the digests against known references and tag the object. */
export const FinalValidation = async (event) => runState(
  'FinalValidation',
  event,
  () => new ChecksumValidation(event).run()
);
