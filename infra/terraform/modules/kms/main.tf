# Customer-managed KMS key (rotating) for DB, S3, EKS secrets, and the
# application KEK used by indexer/src/secrets (Vault transit/KMS provider).
variable "name" { type = string }

resource "aws_kms_key" "this" {
  description             = "${var.name} data encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "this" {
  name          = "alias/${var.name}"
  target_key_id = aws_kms_key.this.key_id
}

output "key_arn" { value = aws_kms_key.this.arn }
