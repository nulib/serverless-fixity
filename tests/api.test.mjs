// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  ApiRequest,
} from '../src/lib/api.mjs';

const STATE_MACHINE_ARN = 'arn:aws:states:us-east-1:111111111111:stateMachine:fixity';
const EXECUTION_ARN = 'arn:aws:states:us-east-1:111111111111:execution:fixity:run-1';

/** Records the Step Functions calls an ApiRequest makes. */
class FakeSfn {
  constructor(response = {}) {
    this.response = response;
    this.calls = [];
  }

  async send(command) {
    this.calls.push({ name: command.constructor.name, input: command.input });
    return { $metadata: { httpStatusCode: 200 }, ...this.response };
  }
}

const withSfn = (event, sfn) => {
  const request = new ApiRequest(event, {});
  request.sfn = sfn;
  return request;
};

describe('ApiRequest', () => {
  before(() => {
    process.env.ENV_STATE_MACHINE_ARN = STATE_MACHINE_ARN;
  });

  after(() => {
    delete process.env.ENV_STATE_MACHINE_ARN;
  });

  it('starts a run from a POST and echoes the normalized input', async () => {
    const sfn = new FakeSfn({ executionArn: EXECUTION_ARN, startDate: new Date(0) });
    const response = await withSfn({
      httpMethod: 'POST',
      body: JSON.stringify({ Bucket: 'preservation', Key: 'reel.mov', Algorithms: ['sha256', 'md5'] }),
    }, sfn).request();

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['Content-Type'], 'application/json');

    const body = JSON.parse(response.body);
    assert.equal(body.executionArn, EXECUTION_ARN);
    assert.deepEqual(body.Input.Algorithms, ['md5', 'sha256']);
    assert.equal(body.Input.StoreChecksumOnTagging, true);
    assert.ok(!('$metadata' in body));

    const [call] = sfn.calls;
    assert.equal(call.name, 'StartExecutionCommand');
    assert.equal(call.input.stateMachineArn, STATE_MACHINE_ARN);
    assert.deepEqual(JSON.parse(call.input.input).Algorithms, ['md5', 'sha256']);
  });

  it('rejects a request the state machine could not act on', async () => {
    const sfn = new FakeSfn();
    const response = await withSfn({
      httpMethod: 'POST',
      body: JSON.stringify({ Bucket: 'preservation' }),
    }, sfn).request();

    assert.equal(response.statusCode, 400);
    assert.match(JSON.parse(response.body).Error, /missing Key/);
    assert.equal(sfn.calls.length, 0, 'nothing should be started');
  });

  it('rejects a malformed body', async () => {
    const response = await withSfn({ httpMethod: 'POST', body: '{oops' }, new FakeSfn()).request();
    assert.equal(response.statusCode, 400);
    assert.match(JSON.parse(response.body).Error, /not valid JSON/);
  });

  it('describes an execution given its full ARN', async () => {
    const sfn = new FakeSfn({ status: 'SUCCEEDED' });
    const response = await withSfn({
      httpMethod: 'GET',
      queryStringParameters: { executionArn: EXECUTION_ARN },
    }, sfn).request();

    assert.equal(response.statusCode, 200);
    assert.equal(JSON.parse(response.body).status, 'SUCCEEDED');
    assert.equal(sfn.calls[0].input.executionArn, EXECUTION_ARN);
  });

  it('accepts a bare execution name as shorthand', async () => {
    const sfn = new FakeSfn({ status: 'RUNNING' });
    await withSfn({ httpMethod: 'GET', queryStringParameters: { executionArn: 'run-1' } }, sfn).request();
    assert.equal(sfn.calls[0].input.executionArn, EXECUTION_ARN);
  });

  it('rejects a nonsense executionArn without calling Step Functions', async () => {
    const sfn = new FakeSfn();
    const response = await withSfn({
      httpMethod: 'GET',
      queryStringParameters: { executionArn: 'arn:aws:states:us-east-1:1:execution:x:y' },
    }, sfn).request();

    assert.equal(response.statusCode, 400);
    assert.equal(sfn.calls.length, 0);
  });

  it('requires an executionArn on GET', async () => {
    const response = await withSfn({ httpMethod: 'GET' }, new FakeSfn()).request();
    assert.equal(response.statusCode, 400);
    assert.match(JSON.parse(response.body).Error, /missing executionArn/);
  });

  it('leaves CORS headers to the function URL', async () => {
    const sfn = new FakeSfn({ status: 'SUCCEEDED' });
    const response = await withSfn({
      httpMethod: 'GET',
      queryStringParameters: { executionArn: EXECUTION_ARN },
    }, sfn).request();

    /* the function URL adds these itself; a duplicate header is fatal to a
     * browser, so the handler must not emit one */
    const cors = Object.keys(response.headers).filter((name) => /^access-control-/i.test(name));
    assert.deepEqual(cors, []);
  });

  it('refuses methods it does not implement', async () => {
    const response = await withSfn({ httpMethod: 'DELETE' }, new FakeSfn()).request();
    assert.equal(response.statusCode, 400);
    assert.match(JSON.parse(response.body).Error, /DELETE is not supported/);
  });

  it('will not start without knowing which state machine to drive', () => {
    delete process.env.ENV_STATE_MACHINE_ARN;
    assert.throws(() => new ApiRequest({}, {}), /ENV_STATE_MACHINE_ARN/);
    process.env.ENV_STATE_MACHINE_ARN = STATE_MACHINE_ARN;
  });
});
