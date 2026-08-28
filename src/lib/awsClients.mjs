// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  S3Client,
} from '@aws-sdk/client-s3';

import {
  SFNClient,
} from '@aws-sdk/client-sfn';

import {
  fromTemporaryCredentials,
} from '@aws-sdk/credential-providers';

const SOLUTION_ID = process.env.ENV_SOLUTION_ID ?? 'serverless-fixity';

/**
 * S3 clients are cached per role so a warm container reuses both the
 * connection pool and the assumed-role credentials, which the credential
 * provider refreshes on its own.
 */
const s3Clients = new Map();

/**
 * @param {object} [options]
 * @param {string} [options.vendorRole] role to assume for cross-account reads;
 *   omit to use the function's own execution role
 * @param {string} [options.vendorExternalId] external id the role's trust
 *   policy requires, if any
 */
export function getS3Client({ vendorRole, vendorExternalId } = {}) {
  const cacheKey = `${vendorRole ?? ''}|${vendorExternalId ?? ''}`;

  let client = s3Clients.get(cacheKey);
  if (!client) {
    client = new S3Client({
      credentials: vendorRole
        ? fromTemporaryCredentials({
          params: {
            RoleArn: vendorRole,
            RoleSessionName: SOLUTION_ID,
            ...(vendorExternalId ? { ExternalId: vendorExternalId } : {}),
          },
        })
        : undefined,
    });
    s3Clients.set(cacheKey, client);
  }
  return client;
}

let sfnClient;

export function getSfnClient() {
  sfnClient ??= new SFNClient({});
  return sfnClient;
}

/** Test seam: drop the cached clients so a fake can be injected. */
export function resetClients() {
  s3Clients.clear();
  sfnClient = undefined;
}
