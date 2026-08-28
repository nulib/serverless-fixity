output "function_url" {
  description = "POST here to start a fixity run; GET here to check on one. Null when create_function_url is false."
  value       = var.create_function_url ? aws_lambda_function_url.on_request[0].function_url : null
}

output "state_machine_arn" {
  description = "Start executions against this ARN to bypass the request handler entirely."
  value       = aws_sfn_state_machine.fixity.arn
}

output "state_machine_name" {
  description = "Name of the fixity state machine."
  value       = aws_sfn_state_machine.fixity.name
}

output "function_names" {
  description = "Lambda function names, keyed by state."
  value       = { for key, function in aws_lambda_function.functions : key => function.function_name }
}

output "function_arns" {
  description = <<-EOT
    Lambda function ARNs, keyed by state. Grant callers lambda:InvokeFunctionUrl
    on the on_request ARN so they can reach the endpoint.
  EOT
  value       = { for key, function in aws_lambda_function.functions : key => function.arn }
}

output "role_names" {
  description = <<-EOT
    Execution role names, keyed by state. Attach your own policies to these to
    widen access -- to a KMS key protecting your objects, for instance -- without
    forking the module.
  EOT
  value       = { for key, role in aws_iam_role.functions : key => role.name }
}

output "role_arns" {
  description = "Execution role ARNs, keyed by state. Name these in a bucket policy to grant cross-account access."
  value       = { for key, role in aws_iam_role.functions : key => role.arn }
}

output "log_group_names" {
  description = "CloudWatch log group names, keyed by state."
  value       = { for key, group in aws_cloudwatch_log_group.functions : key => group.name }
}

output "package_path" {
  description = "Path to the deployment package the module used."
  value       = local.package_path
}
