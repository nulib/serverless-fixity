# Packaging the Lambda source.
#
# By default the module builds the deployment package the same way `sam build`
# does: copy src/, install production dependencies, zip the result. Set
# var.lambda_zip_path to skip this and supply a package built elsewhere, which
# is what you want in a pipeline that has no npm on the Terraform runner.

locals {
  build_package = var.lambda_zip_path == null

  source_dir = abspath("${path.module}/../src")
  build_root = abspath("${path.module}/.terraform-build")
  stage_dir  = abspath("${path.module}/.terraform-build/package")
  zip_output = abspath("${path.module}/.terraform-build/fixity.zip")

  # Everything under src/ except installed dependencies, so the hash tracks our
  # code and the lock file but not node_modules.
  source_files = [
    for file in fileset(local.source_dir, "**") : file
    if !startswith(file, "node_modules/")
  ]

  # Rebuild whenever the source or the lock file changes.
  source_hash = sha1(join("", [
    for file in sort(local.source_files) : filesha1("${local.source_dir}/${file}")
  ]))

  package_path = local.build_package ? data.archive_file.lambda[0].output_path : var.lambda_zip_path
  package_hash = local.build_package ? data.archive_file.lambda[0].output_base64sha256 : filebase64sha256(var.lambda_zip_path)
}

resource "terraform_data" "build" {
  count = local.build_package ? 1 : 0

  triggers_replace = {
    source_hash = local.source_hash
    npm_command = var.npm_command
  }

  provisioner "local-exec" {
    working_dir = local.source_dir

    # A staging copy keeps the build out of the source tree, so a developer's
    # own node_modules (dev dependencies and all) never reaches the package.
    command = <<-EOT
      set -eu
      rm -rf '${local.stage_dir}'
      mkdir -p '${local.stage_dir}'
      cp index.mjs package.json package-lock.json '${local.stage_dir}/'
      cp -R lib '${local.stage_dir}/'
      cd '${local.stage_dir}'
      ${var.npm_command}
    EOT
  }
}

# depends_on defers the read until after the build has run, so the archive is
# taken from a populated staging directory rather than an empty one.
data "archive_file" "lambda" {
  count = local.build_package ? 1 : 0

  type        = "zip"
  source_dir  = local.stage_dir
  output_path = local.zip_output

  depends_on = [terraform_data.build]
}
