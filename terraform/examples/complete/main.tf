# A representative deployment: two named buckets, and the hashing function given
# extra memory so large objects need fewer invocations.

terraform {
  required_version = ">= 1.4.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0, < 7.0"
    }
  }
}

provider "aws" {
  region = var.region
}

variable "region" {
  type    = string
  default = "us-east-1"
}

module "fixity" {
  source = "../../"

  name            = "preservation-fixity"
  content_buckets = ["my-preservation-masters", "my-preservation-derivatives"]

  compute_checksum_memory_size = 5120
  allow_origins                = "https://archive.example.edu"
  log_retention_in_days        = 90

  tags = {
    Application = "digital-preservation"
    ManagedBy   = "terraform"
  }
}

# Anything that should be able to start a run needs this on its own identity.
data "aws_iam_policy_document" "invoke_fixity" {
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
}

resource "aws_iam_policy" "invoke_fixity" {
  name        = "invoke-preservation-fixity"
  description = "Call the fixity endpoint"
  policy      = data.aws_iam_policy_document.invoke_fixity.json
}

output "function_url" {
  value = module.fixity.function_url
}

output "state_machine_arn" {
  value = module.fixity.state_machine_arn
}

# Useful in the object owner's bucket policy when the buckets live elsewhere.
output "reader_role_arns" {
  value = module.fixity.role_arns
}
