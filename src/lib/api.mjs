// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  DescribeExecutionCommand,
  StartExecutionCommand,
} from '@aws-sdk/client-sfn';

import {
  getSfnClient,
} from './awsClients.mjs';

import {
  normalizeRequest,
} from './fixityState.mjs';

import {
  ConfigurationError,
  InvalidArgumentError,
  NotImplementedError,
} from './errors.mjs';

const EXECUTION_ARN = /^arn:aws[a-z-]*:states:[a-z\d-]+:\d{12}:execution:[\w-]+:[\w-]+$/;

/**
 * REST facade over the state machine: POST starts a fixity run, GET reports on
 * one. Preflight never reaches here -- API Gateway answers OPTIONS itself.
 */
export class ApiRequest {
  constructor(event, context) {
    const stateMachineArn = process.env.ENV_STATE_MACHINE_ARN;
    if (!stateMachineArn) {
      throw new ConfigurationError('ENV_STATE_MACHINE_ARN is not set');
    }

    this.event = event;
    this.context = context;
    this.stateMachineArn = stateMachineArn;
    this.allowOrigins = process.env.ENV_ALLOW_ORIGINS || '*';
    this.sfn = getSfnClient();
  }

  get corsHeaders() {
    return {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': this.allowOrigins,
    };
  }

  async request() {
    const method = this.event.httpMethod ?? this.event.requestContext?.http?.method;
    try {
      switch (method) {
        case 'GET':
          return this.reply(200, await this.onGET());
        case 'POST':
          return this.reply(200, await this.onPOST());
        default:
          throw new NotImplementedError(`${method} is not supported`);
      }
    } catch (e) {
      console.error(e);
      return this.reply(e.statusCode === 403 ? 403 : 400, { Error: e.message });
    }
  }

  reply(statusCode, body) {
    return {
      statusCode,
      headers: this.corsHeaders,
      body: JSON.stringify(body),
    };
  }

  /**
   * GET /fixity?executionArn=<arn|name>
   *
   * The bare execution name is accepted as shorthand and expanded against this
   * deployment's own state machine.
   */
  async onGET() {
    const raw = this.event.queryStringParameters?.executionArn;
    if (!raw) {
      throw new InvalidArgumentError('missing executionArn query parameter');
    }

    const name = decodeURIComponent(raw);
    const executionArn = name.startsWith('arn:')
      ? name
      : `${this.stateMachineArn.replace(':stateMachine:', ':execution:')}:${name}`;

    if (!EXECUTION_ARN.test(executionArn)) {
      throw new InvalidArgumentError(`invalid executionArn: ${name}`);
    }

    return this.sfn.send(new DescribeExecutionCommand({ executionArn }))
      .then(({ $metadata, ...execution }) => execution);
  }

  /**
   * POST /fixity
   *
   * Body:
   * {
   *   "Bucket": "my-bucket",                      // required
   *   "Key": "path/to/object",                    // required
   *   "Algorithms": ["md5", "sha256"],            // or "Algorithm": "md5"
   *   "Expected": { "md5": "<hex>" },             // or a bare hex string
   *   "ChunkSize": 21474836480,
   *   "StoreChecksumOnTagging": true,
   *   "RestoreRequest": { "Days": 1, "Tier": "Bulk" },
   *   "VendorRole": "arn:aws:iam::111111111111:role/CrossAccountRead",
   *   "VendorExternalId": "..."
   * }
   */
  async onPOST() {
    let body;
    try {
      body = JSON.parse(this.event.body ?? '{}');
    } catch (e) {
      throw new InvalidArgumentError(`request body is not valid JSON: ${e.message}`);
    }

    const input = normalizeRequest(body);

    const { $metadata, ...execution } = await this.sfn.send(new StartExecutionCommand({
      stateMachineArn: this.stateMachineArn,
      input: JSON.stringify(input),
    }));

    return { ...execution, Input: input };
  }
}
