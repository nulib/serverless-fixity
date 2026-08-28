#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Summarize what one state machine execution cost: how many state transitions
 * it took, and how much Lambda runtime each state accounted for.
 *
 * Usage:
 *   node tools/execution-summary.mjs <execution-arn> [--csv summary.csv]
 */

import {
  writeFileSync,
} from 'node:fs';

import {
  LambdaClient,
  GetFunctionConfigurationCommand,
} from '@aws-sdk/client-lambda';

import {
  SFNClient,
  GetExecutionHistoryCommand,
} from '@aws-sdk/client-sfn';

function parseArgv(argv) {
  const [executionArn, ...rest] = argv;
  const options = { executionArn };
  for (let i = 0; i < rest.length; i += 2) {
    options[rest[i].replace(/^--/, '')] = rest[i + 1];
  }
  return options;
}

/**
 * Walk the execution history, pairing each Lambda invocation with the state it
 * belongs to. Timings come from the Started/Succeeded event pair.
 */
async function collect(sfn, executionArn) {
  const states = new Map();
  let transitions = 0;
  let nextToken;

  /* one Lambda invocation in flight per state at a time, keyed by state name */
  const pending = new Map();
  const stateOfEvent = new Map();

  do {
    const page = await sfn.send(new GetExecutionHistoryCommand({
      executionArn,
      maxResults: 1000,
      nextToken,
    }));

    for (const event of page.events) {
      if (event.type.endsWith('Entered')) {
        transitions += 1;
      }

      switch (event.type) {
        case 'TaskStateEntered': {
          const name = event.stateEnteredEventDetails.name;
          stateOfEvent.set(event.id, name);
          pending.set(name, {});
          break;
        }
        case 'LambdaFunctionScheduled':
        case 'LambdaFunctionStarted':
        case 'LambdaFunctionSucceeded':
        case 'LambdaFunctionFailed': {
          /* these chain back to the TaskStateEntered event by previousEventId */
          const name = stateOfEvent.get(event.previousEventId);
          if (name) {
            stateOfEvent.set(event.id, name);
          }
          const state = stateOfEvent.get(event.id);
          const record = pending.get(state);
          if (!record) {
            break;
          }
          if (event.type === 'LambdaFunctionScheduled') {
            record.resource = event.lambdaFunctionScheduledEventDetails?.resource?.split(':').pop();
          } else if (event.type === 'LambdaFunctionStarted') {
            record.startedAt = new Date(event.timestamp).getTime();
          } else {
            record.endedAt = new Date(event.timestamp).getTime();
          }
          break;
        }
        case 'TaskStateExited': {
          const name = event.stateExitedEventDetails.name;
          const record = pending.get(name);
          pending.delete(name);
          if (!record) {
            break;
          }
          const entry = states.get(name) ?? { resource: record.resource, invocations: 0, elapsed: 0 };
          entry.resource ??= record.resource;
          entry.invocations += 1;
          if (record.startedAt && record.endedAt) {
            entry.elapsed += record.endedAt - record.startedAt;
          }
          states.set(name, entry);
          break;
        }
        default:
          break;
      }
    }

    nextToken = page.nextToken;
  } while (nextToken);

  return { transitions, states };
}

async function memorySizes(lambda, states) {
  const names = [...new Set([...states.values()].map((state) => state.resource).filter(Boolean))];
  const sizes = new Map();

  await Promise.all(names.map(async (name) => {
    try {
      const config = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: name }));
      sizes.set(name, config.MemorySize);
    } catch {
      /* the function may have been deleted since the run; report what we can */
      sizes.set(name, undefined);
    }
  }));

  return sizes;
}

function render({ transitions, states }, sizes) {
  const rows = [['State', 'Function', 'Memory (MB)', 'Invocations', 'Lambda runtime (ms)']];
  for (const [name, state] of states) {
    rows.push([name, state.resource ?? '', sizes.get(state.resource) ?? '', state.invocations, state.elapsed]);
  }
  const totalRuntime = [...states.values()].reduce((sum, state) => sum + state.elapsed, 0);
  rows.push([]);
  rows.push(['Total state transitions', transitions]);
  rows.push(['Total Lambda runtime (ms)', totalRuntime]);
  return rows;
}

const options = parseArgv(process.argv.slice(2));
if (!options.executionArn) {
  console.error('usage: node tools/execution-summary.mjs <execution-arn> [--csv summary.csv]');
  process.exit(1);
}

const summary = await collect(new SFNClient({}), options.executionArn);
const sizes = await memorySizes(new LambdaClient({}), summary.states);
const rows = render(summary, sizes);

const width = 28;
for (const row of rows) {
  console.log(row.map((cell, i) => (i === 0 ? String(cell).padEnd(width) : String(cell).padStart(12))).join(' '));
}

if (options.csv) {
  writeFileSync(options.csv, rows.map((row) => row.map((cell) => `"${cell}"`).join(',')).join('\n'));
  console.log(`\nwrote ${options.csv}`);
}
