# Terraform module: serverless fixity

Deploys the same resources as the SAM template at the repository root, as a
module you can call from an existing Terraform configuration.

Use this if your infrastructure already lives in Terraform and you would rather
not run `sam deploy` beside it. Use the SAM template if this stack stands alone,
or if you want `sam sync` while iterating on the Lambda code.

## Usage

```hcl
module "fixity" {
  source = "github.com/nulib/serverless-fixity//terraform"

  name            = "preservation-fixity"
  content_buckets = ["my-preservation-masters"]
}

output "fixity_endpoint" {
  value = module.fixity.function_url
}
```

A worked example, including the IAM policy a caller needs, is in
[examples/complete](examples/complete).

## What it creates

| Resource | Count | Notes |
| --- | --- | --- |
| `aws_lambda_function` | 4 | One per state, plus the request handler. All share one deployment package and differ only in handler and sizing. |
| `aws_iam_role` + `aws_iam_role_policy` | 5 | One per function, one for the state machine. Each grants only what that state needs. |
| `aws_cloudwatch_log_group` | 4 | Created explicitly so retention is set and logs do not accumulate forever. |
| `aws_sfn_state_machine` | 1 | Reads `../statemachine/fixity.asl.json`, the same definition the SAM template deploys. |
| `aws_lambda_function_url` | 0 or 1 | Skipped when `create_function_url = false`. |

The state machine definition is shared rather than copied: its `${...}`
placeholders are exactly `templatefile()` interpolation syntax, so both stacks
consume one file and cannot drift apart.

## Building the deployment package

By default the module builds the package the way `sam build` does — copy `src/`
to a staging directory, install production dependencies, zip it — which means
**npm must be available on the machine running Terraform**. The build reruns
only when the source or lock file changes.

Because the archive is produced during apply, Terraform reports the package hash
as "known after apply" in the plan. That is expected.

To build elsewhere instead, point the module at a prebuilt zip:

```hcl
module "fixity" {
  source          = "github.com/nulib/serverless-fixity//terraform"
  lambda_zip_path = "${path.module}/build/fixity.zip"
}
```

The package must contain `index.mjs`, `lib/`, and `node_modules/` with the AWS
SDK clients from `src/package.json`. `sam build` produces exactly this in
`.aws-sam/build/ComputeChecksumFunction`.

## Calling the endpoint

The function URL uses `AWS_IAM` auth, so callers sign with SigV4 and need
`lambda:InvokeFunctionUrl` on the handler in their own IAM policy:

```hcl
statement {
  effect    = "Allow"
  actions   = ["lambda:InvokeFunctionUrl"]
  resources = [module.fixity.function_arns["on_request"]]

  condition {
    test     = "StringEquals"
    variable = "lambda:FunctionUrlAuthType"
    values   = ["AWS_IAM"]
  }
}
```

No resource-based permission is attached, so this covers same-account callers.
Granting another account access needs an `aws_lambda_permission` with
`function_url_auth_type = "AWS_IAM"`.

Request and response shapes are documented in the [root README](../README.md).

## Inputs

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | `"serverless-fixity"` | Name prefix for every resource. |
| `content_buckets` | `list(string)` | `["*"]` | Buckets the solution may read. Narrow this. |
| `create_function_url` | `bool` | `true` | Set false to expose no endpoint and drive the state machine directly. |
| `allow_origins` | `string` | `"*"` | Origin allowed by the function URL's CORS configuration. |
| `compute_checksum_memory_size` | `number` | `3008` | Memory buys proportional CPU and network, so raising this shortens runs. |
| `single_pass_limit_bytes` | `number` | `8589934592` | Objects at or below this size take the `node:crypto` fast path. |
| `lambda_architecture` | `string` | `"arm64"` | No native dependencies, so either works. |
| `log_retention_in_days` | `number` | `30` | `0` keeps logs forever. |
| `lambda_zip_path` | `string` | `null` | Prebuilt package; skips the npm build. |
| `npm_command` | `string` | `"npm ci --omit=dev --no-audit --no-fund"` | Used when building the package. |
| `tags` | `map(string)` | `{}` | Applied to everything that supports tags. |

## Outputs

| Name | Description |
| --- | --- |
| `function_url` | The endpoint. Null when `create_function_url` is false. |
| `state_machine_arn` / `state_machine_name` | For starting executions directly. |
| `function_names` / `function_arns` | Keyed by state: `check_restore_status`, `compute_checksum`, `final_validation`, `on_request`. |
| `role_names` / `role_arns` | Keyed by state. Attach extra policies to these — a KMS key for encrypted objects, say — instead of forking the module. |
| `log_group_names` | Keyed by state. |
| `package_path` | The deployment package that was used. |

## Differences from the SAM template

- **Content buckets** are a `list(string)` here rather than a comma-separated
  string, which is the natural Terraform shape.
- **The build is explicit.** SAM builds as a separate `sam build` step; this
  module builds during apply, or takes a package you built yourself.
- **Content buckets must be in this account.** Neither stack reads across
  accounts. To check objects someone else owns, have them grant the roles in
  `role_arns` access in their bucket policy, and attach a matching policy of
  your own to those roles.
