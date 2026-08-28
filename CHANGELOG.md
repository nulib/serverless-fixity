# Change Log
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Added
- A Terraform module in `terraform/` that deploys the same resources as the SAM
  template, for configurations that already use Terraform. It shares
  `statemachine/fixity.asl.json` with the SAM template rather than copying it,
  so the two cannot drift, and it builds the Lambda package itself or takes a
  prebuilt zip via `lambda_zip_path`.
- CI validates the Terraform module and its example.

### Changed
- CORS is left entirely to the Lambda function URL. The request handler no
  longer emits an `Access-Control-Allow-Origin` header of its own, which a
  browser would reject as a duplicate, and `ENV_ALLOW_ORIGINS` is gone.

### Removed
- Cross-account (vendor) reads. `VendorRole` and `VendorExternalId` are no
  longer accepted on a request, and the code that assumed those roles is gone,
  matching the deployment templates, which had already dropped the
  `sts:AssumeRole` grant. To check objects another account owns, grant the
  functions' roles access in that account's bucket policy.
- The `@aws-sdk/credential-providers` dependency, which only existed to assume
  vendor roles, and the now-unused `ENV_SOLUTION_ID` environment variable.
- Stale README sections describing `VendorAccountRoleList`, `ApiStageName` and
  `execute-api` request signing, none of which apply to a function URL.

## [2.0.0] - 2026-08-28

A rewrite. The behaviour of a fixity run is the same, but how it is deployed,
what it returns, and what it runs on all changed.

### Added
- Multiple algorithms in a single pass. `Algorithms: ["md5", "sha1", "sha256"]`
  reads the object exactly once and advances every hash over the same bytes, so
  cost and egress scale with object size rather than with the number of digests.
  `FinalValidation` compares and tags each algorithm independently.
- Deadline-aware chunking. `ComputeChecksum` watches the invocation clock and
  suspends its hash state when time runs short, so `ChunkSize` is a ceiling
  rather than a way to overrun the timeout and lose the range's work.
- A `node:crypto` fast path for objects that finish in one invocation, roughly
  ten times faster than the resumable implementation. `SinglePassLimitBytes`
  sets the threshold; a single-pass attempt that runs out of time falls back to
  the resumable path instead of failing.
- Restore support for archived Intelligent-Tiering objects, which report their
  state through `ArchiveStatus` rather than `StorageClass`.
- Unit tests as plain `node:test`, with the portable hashes checked against
  `node:crypto` across block boundaries, ragged chunk splits, and repeated
  serialize/deserialize cycles. No AWS calls; clients are injected.
- Explicit CloudWatch log groups with a configurable retention, replacing log
  groups that were created implicitly and kept forever.
- GitHub Actions CI running lint, tests, `sam validate --lint` and `sam build`.

### Changed
- Deployment is now a single SAM template. `sam build && sam deploy --guided`
  replaces the five bash scripts, the staging S3 bucket, the `%%PLACEHOLDER%%`
  substitution pass, and the three nested CloudFormation stacks.
- Node.js 24 throughout, as ES modules, on AWS SDK for JavaScript v3. Lambda
  functions default to arm64.
- Checksums are reported under `Checksums`, keyed by algorithm, each with its
  own `Computed`, `Expected`, `ComparedWith`, `ComparedResult` and `TagUpdated`.
  The old top-level `Computed`/`Expected`/`ComparedWith` fields are gone.
  `ComparedResult` remains at the top level as the worst per-algorithm verdict.
- `Expected` accepts a map keyed by algorithm. A bare hex string still works
  when exactly one algorithm was requested.
- The API is a fixed `/fixity` path instead of a `{operation}` path parameter,
  and API Gateway answers CORS preflight itself rather than routing OPTIONS
  through Lambda.
- The `x-amz-restore` header is parsed by field name, which is robust to the
  comma inside `expiry-date`.
- Retries no longer burn attempts on errors that cannot succeed: `ForbiddenError`,
  `MismatchETagError` and `MismatchFileSizeError` are terminal.

### Removed
- The SNS topic, the `Email` parameter, and all notification code. Subscribe an
  EventBridge rule to Step Functions execution status changes instead.
- Anonymous usage metrics, the solution UUID custom resource, and the
  `custom-resources` Lambda that existed to support them.
- The `OnChecksumError` Lambda and its EventBridge rule, which only existed to
  publish failures to SNS. Failures are visible in the execution history.
- The `resumable-hash` native Lambda layer and its Dockerfile, along with the
  `spark-md5` and `rusha` dependencies. Hashing is now dependency-free, and
  building the solution no longer needs Docker.
- The `aws-sdk` v2 Lambda layer.
- Suspended SHA-1 state no longer carries a 128 KB heap through the Step
  Functions payload; every algorithm's state now serializes to about 100 bytes.
- Architecture diagrams that described the removed nested-stack and SNS design;
  the README carries diagrams generated from the current one.

## [1.4.0] - 2024-04-24
### Changed
- update to NodeJS 20.x
- added aws-sdk layer to all lambda functions

## [1.3.0] - 2023-01-12
### Added
- added suport to run checksum with cross-account buckets by assuming cross-account IAM roles through $.VendorRole and $.VendorExternalId (optional)
- added a stack parameter to specify a list of Vendor's IAM roles

### Changed
- update README

### Removed

## [1.2.0] - 2022-10-20
### Added
- added `sha256` checksum
- added a stack parameter to specify a list of buckets to give access. default to asterisk (*) for all buckets and objects 

### Changed
- revise the fixity state machine to use $.SecondsPath and uses `Step Functions Execution Status Change` to handle execution errors
- clean up CFN templates to use yaml syntax
- update README

### Removed

## [1.1.0] - 2021-09-16
### Added

### Changed
- handles zero byte object size
- updated runtime to nodejs14.x
- updated deploy script to check bucket ownership
- added solution-specific user agent to AWS service requests
- updated Copyright

### Removed

__


## [1.0.0] - 2019-11-21
### Added
- initial release

### Changed

### Removed
