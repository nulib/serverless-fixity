# The endpoint is a Lambda function URL rather than an API Gateway stage: it is
# one resource instead of a dozen, costs nothing per request, and AWS_IAM auth
# gives the same SigV4 protection.
#
# Callers need lambda:InvokeFunctionUrl on the function in their own IAM policy.
# No resource-based permission is created here, which means same-account callers
# only; granting another account access needs an aws_lambda_permission with
# function_url_auth_type = "AWS_IAM".

resource "aws_lambda_function_url" "on_request" {
  count = var.create_function_url ? 1 : 0

  function_name      = aws_lambda_function.functions["on_request"].function_name
  authorization_type = "AWS_IAM"

  cors {
    allow_origins = [var.allow_origins]
    allow_methods = ["GET", "POST"]
    allow_headers = [
      "Authorization",
      "Content-Type",
      "X-Amz-Date",
      "X-Amz-Security-Token",
      "X-Amz-Content-Sha256",
      "X-Api-Key",
    ]
  }
}
