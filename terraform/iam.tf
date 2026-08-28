# One role per function, each granted only what that state needs.

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# Writing to the function's own log group. The group itself is created by this
# module, so CreateLogGroup is deliberately absent.
data "aws_iam_policy_document" "logs" {
  for_each = local.functions

  statement {
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.functions[each.key].arn}:*"]
  }
}

data "aws_iam_policy_document" "check_restore_status" {
  source_policy_documents = [data.aws_iam_policy_document.logs["check_restore_status"].json]

  statement {
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:GetObjectVersion", "s3:RestoreObject"]
    resources = local.content_object_arns
  }
}

data "aws_iam_policy_document" "compute_checksum" {
  source_policy_documents = [data.aws_iam_policy_document.logs["compute_checksum"].json]

  statement {
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:GetObjectVersion"]
    resources = local.content_object_arns
  }
}

data "aws_iam_policy_document" "final_validation" {
  source_policy_documents = [data.aws_iam_policy_document.logs["final_validation"].json]

  statement {
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:GetObjectTagging",
      "s3:GetObjectVersionTagging",
      "s3:PutObjectTagging",
      "s3:PutObjectVersionTagging",
    ]
    resources = local.content_object_arns
  }
}

# The state machine ARN is composed rather than read from the resource: the
# state machine depends on the functions, which depend on these policies, so
# referencing it here would close a dependency cycle.
data "aws_iam_policy_document" "on_request" {
  source_policy_documents = [data.aws_iam_policy_document.logs["on_request"].json]

  statement {
    effect    = "Allow"
    actions   = ["states:StartExecution"]
    resources = ["arn:${local.partition}:states:${local.region}:${local.account_id}:stateMachine:${local.state_machine_name}"]
  }

  statement {
    effect    = "Allow"
    actions   = ["states:DescribeExecution"]
    resources = ["arn:${local.partition}:states:${local.region}:${local.account_id}:execution:${local.state_machine_name}:*"]
  }
}

locals {
  function_policies = {
    check_restore_status = data.aws_iam_policy_document.check_restore_status.json
    compute_checksum     = data.aws_iam_policy_document.compute_checksum.json
    final_validation     = data.aws_iam_policy_document.final_validation.json
    on_request           = data.aws_iam_policy_document.on_request.json
  }

}

resource "aws_iam_role" "functions" {
  for_each = local.functions

  name               = "${each.value}-role"
  description        = "Execution role for ${each.value}"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
  tags               = var.tags
}

resource "aws_iam_role_policy" "functions" {
  for_each = local.functions

  name   = each.value
  role   = aws_iam_role.functions[each.key].id
  policy = local.function_policies[each.key]
}


# Step Functions may invoke the three task functions and nothing else.
data "aws_iam_policy_document" "state_machine_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "state_machine" {
  statement {
    effect  = "Allow"
    actions = ["lambda:InvokeFunction"]
    resources = [
      aws_lambda_function.functions["check_restore_status"].arn,
      aws_lambda_function.functions["compute_checksum"].arn,
      aws_lambda_function.functions["final_validation"].arn,
    ]
  }
}

resource "aws_iam_role" "state_machine" {
  name               = "${local.state_machine_name}-role"
  description        = "Execution role for the ${local.state_machine_name} state machine"
  assume_role_policy = data.aws_iam_policy_document.state_machine_assume_role.json
  tags               = var.tags
}

resource "aws_iam_role_policy" "state_machine" {
  name   = local.state_machine_name
  role   = aws_iam_role.state_machine.id
  policy = data.aws_iam_policy_document.state_machine.json
}
