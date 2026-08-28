# Shared lookups and naming.

data "aws_partition" "current" {}

data "aws_region" "current" {}

data "aws_caller_identity" "current" {}

locals {
  partition  = data.aws_partition.current.partition
  region     = data.aws_region.current.region
  account_id = data.aws_caller_identity.current.account_id

  functions = {
    check_restore_status = "${var.name}-CheckRestoreStatus"
    compute_checksum     = "${var.name}-ComputeChecksum"
    final_validation     = "${var.name}-FinalValidation"
    on_request           = "${var.name}-OnRequest"
  }

  state_machine_name = "${var.name}-fixity"

  # Object ARNs the functions are allowed to read. ["*"] yields arn:aws:s3:::*/*,
  # matching the module's permissive default.
  content_object_arns = [
    for bucket in var.content_buckets : "arn:${local.partition}:s3:::${bucket}/*"
  ]

  # Environment shared by every function. AWS_MAX_ATTEMPTS trims the SDK's own
  # retries, since the state machine already retries and a long client-side
  # retry can eat the invocation's remaining time.
  common_environment = {
    AWS_MAX_ATTEMPTS = "3"
    NODE_OPTIONS     = "--enable-source-maps"
  }
}
