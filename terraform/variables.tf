variable "name" {
  description = "Name prefix for every resource the module creates."
  type        = string
  default     = "serverless-fixity"

  validation {
    condition     = can(regex("^[a-zA-Z][a-zA-Z0-9-]{0,48}$", var.name))
    error_message = "name must start with a letter and contain only letters, digits and hyphens (max 49 characters)."
  }
}

variable "content_buckets" {
  description = <<-EOT
    Buckets the solution may read, by name. The default grants access to every
    bucket in the account; narrow it to the buckets you actually check.
  EOT
  type        = list(string)
  default     = ["*"]

  validation {
    condition     = length(var.content_buckets) > 0
    error_message = "content_buckets must name at least one bucket, or [\"*\"] for all of them."
  }
}

variable "create_function_url" {
  description = <<-EOT
    Whether to give the request handler a function URL. Set false to drive the
    state machine directly with StartExecution and expose no endpoint at all.
  EOT
  type        = bool
  default     = true
}

variable "allow_origins" {
  description = "Origin allowed by the function URL's CORS configuration."
  type        = string
  default     = "*"
}

variable "compute_checksum_memory_size" {
  description = <<-EOT
    Memory for the hashing function, in MB. Memory buys proportional CPU and
    network, so raising this speeds up hashing and shortens runs.
  EOT
  type        = number
  default     = 3008

  validation {
    condition     = var.compute_checksum_memory_size >= 512 && var.compute_checksum_memory_size <= 10240
    error_message = "compute_checksum_memory_size must be between 512 and 10240 MB."
  }
}

variable "single_pass_limit_bytes" {
  description = <<-EOT
    Objects at or below this size are hashed in one invocation with node:crypto,
    which is far faster but cannot be suspended. Larger objects use the
    resumable implementation and may span invocations.
  EOT
  type        = number
  default     = 8589934592
}

variable "lambda_architecture" {
  description = "arm64 is cheaper per millisecond. The functions have no native dependencies, so either works."
  type        = string
  default     = "arm64"

  validation {
    condition     = contains(["arm64", "x86_64"], var.lambda_architecture)
    error_message = "lambda_architecture must be arm64 or x86_64."
  }
}

variable "log_retention_in_days" {
  description = "How long to keep the functions' CloudWatch logs. 0 keeps them forever."
  type        = number
  default     = 30
}

variable "lambda_zip_path" {
  description = <<-EOT
    Path to a prebuilt deployment package. Leave null to have the module build
    one from ../src, which needs npm on the machine running Terraform. Set it to
    build the package in CI instead.
  EOT
  type        = string
  default     = null
}

variable "npm_command" {
  description = "Command used to install production dependencies when building the package."
  type        = string
  default     = "npm ci --omit=dev --no-audit --no-fund"
}

variable "tags" {
  description = "Tags applied to every resource that supports them."
  type        = map(string)
  default     = {}
}
