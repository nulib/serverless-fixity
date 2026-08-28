terraform {
  # 1.4 for the built-in terraform_data resource, which spares callers the
  # null provider just to build the Lambda package.
  required_version = ">= 1.4.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.32" # logging_config on aws_lambda_function
    }
    archive = {
      source  = "hashicorp/archive"
      version = ">= 2.4"
    }
  }
}
