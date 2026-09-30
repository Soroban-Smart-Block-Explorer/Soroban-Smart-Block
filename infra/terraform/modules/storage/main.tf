# Object storage for exports and backups: private, versioned, KMS-encrypted,
# with lifecycle expiry for exports.
variable "name" { type = string }
variable "kms_key_arn" { type = string }
variable "export_expiry_days" { type = number }

resource "aws_s3_bucket" "this" {
  for_each = toset(["exports", "backups"])
  bucket   = "${var.name}-${each.key}"
}

resource "aws_s3_bucket_public_access_block" "this" {
  for_each                = aws_s3_bucket.this
  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "exports" {
  bucket = aws_s3_bucket.this["exports"].id
  rule {
    id     = "expire-exports"
    status = "Enabled"
    filter {}
    expiration {
      days = var.export_expiry_days
    }
  }
}

output "exports_bucket" { value = aws_s3_bucket.this["exports"].bucket }
output "backups_bucket" { value = aws_s3_bucket.this["backups"].bucket }
