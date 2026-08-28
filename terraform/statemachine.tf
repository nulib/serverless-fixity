# The state machine reads the same definition file that the SAM template
# deploys, so the two stacks cannot drift. Its ${...} placeholders are exactly
# templatefile's interpolation syntax, and the JSONPath expressions in the
# definition ("$.Status") are untouched by it.

resource "aws_sfn_state_machine" "fixity" {
  name     = local.state_machine_name
  role_arn = aws_iam_role.state_machine.arn
  tags     = var.tags

  definition = templatefile("${path.module}/../statemachine/fixity.asl.json", {
    CheckRestoreStatusArn = aws_lambda_function.functions["check_restore_status"].arn
    ComputeChecksumArn    = aws_lambda_function.functions["compute_checksum"].arn
    FinalValidationArn    = aws_lambda_function.functions["final_validation"].arn
  })
}
