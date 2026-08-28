# The four functions. They share one deployment package and differ only in
# handler, sizing and permissions.

locals {
  function_config = {
    check_restore_status = {
      handler     = "index.CheckRestoreStatus"
      description = "Pin the object's identity and drive any Glacier restore it needs."
      memory_size = 256
      timeout     = 300
      environment = {}
    }
    compute_checksum = {
      handler     = "index.ComputeChecksum"
      description = "Read a range of the object once and advance every requested hash."
      memory_size = var.compute_checksum_memory_size
      # The state machine loops this function, so it takes the full 15 minutes
      # and suspends its hash state when the deadline nears.
      timeout     = 900
      environment = { ENV_SINGLE_PASS_LIMIT = tostring(var.single_pass_limit_bytes) }
    }
    final_validation = {
      handler     = "index.FinalValidation"
      description = "Compare each computed digest against a known reference and tag the object."
      memory_size = 256
      timeout     = 300
      environment = {}
    }
    on_request = {
      handler     = "index.OnRequest"
      description = "Start a fixity run, or report on an existing one."
      memory_size = 256
      timeout     = 300
      environment = {
        ENV_STATE_MACHINE_ARN = "arn:${local.partition}:states:${local.region}:${local.account_id}:stateMachine:${local.state_machine_name}"
      }
    }
  }
}

resource "aws_cloudwatch_log_group" "functions" {
  for_each = local.functions

  name              = "/aws/lambda/${each.value}"
  retention_in_days = var.log_retention_in_days
  tags              = var.tags
}

resource "aws_lambda_function" "functions" {
  for_each = local.functions

  function_name = each.value
  description   = local.function_config[each.key].description
  role          = aws_iam_role.functions[each.key].arn
  handler       = local.function_config[each.key].handler
  runtime       = "nodejs24.x"
  architectures = [var.lambda_architecture]
  memory_size   = local.function_config[each.key].memory_size
  timeout       = local.function_config[each.key].timeout

  filename         = local.package_path
  source_code_hash = local.package_hash

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.functions[each.key].name
  }

  environment {
    variables = merge(local.common_environment, local.function_config[each.key].environment)
  }

  tags = var.tags

  # The role's policy has to exist before the function runs, and the log group
  # before Lambda would otherwise create it implicitly.
  depends_on = [
    aws_iam_role_policy.functions,
    aws_cloudwatch_log_group.functions,
  ]
}
