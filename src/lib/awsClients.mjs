// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  S3Client,
} from '@aws-sdk/client-s3';

import {
  SFNClient,
} from '@aws-sdk/client-sfn';

/**
 * Clients are cached so a warm container reuses the connection pool across
 * invocations. Both pick up the function's execution role from the
 * environment.
 */

let s3Client;

export function getS3Client() {
  s3Client ??= new S3Client({});
  return s3Client;
}

let sfnClient;

export function getSfnClient() {
  sfnClient ??= new SFNClient({});
  return sfnClient;
}

/** Test seam: drop the cached clients so a fake can be injected. */
export function resetClients() {
  s3Client = undefined;
  sfnClient = undefined;
}
