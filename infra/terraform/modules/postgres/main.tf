# Managed Postgres with PITR (backup retention), encryption, and read replicas.
# The master password is generated and stored by RDS in Secrets Manager
# (manage_master_user_password), so it never lands in Terraform state.
variable "name" { type = string }
variable "vpc_id" { type = string }
variable "vpc_cidr" { type = string }
variable "subnet_ids" { type = list(string) }
variable "kms_key_arn" { type = string }
variable "instance_class" { type = string }
variable "allocated_storage" { type = number }
variable "backup_retention_days" { type = number }
variable "replica_count" { type = number }
variable "multi_az" { type = bool }
variable "deletion_protection" { type = bool }

resource "aws_db_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "db" {
  name   = "${var.name}-db"
  vpc_id = var.vpc_id
  ingress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }
}

resource "aws_db_instance" "primary" {
  identifier                    = var.name
  engine                        = "postgres"
  engine_version                = "16"
  instance_class                = var.instance_class
  allocated_storage             = var.allocated_storage
  db_name                       = "soroban_explorer"
  username                      = "explorer"
  manage_master_user_password   = true
  master_user_secret_kms_key_id = var.kms_key_arn
  storage_encrypted             = true
  kms_key_id                    = var.kms_key_arn
  backup_retention_period       = var.backup_retention_days
  multi_az                      = var.multi_az
  db_subnet_group_name          = aws_db_subnet_group.this.name
  vpc_security_group_ids        = [aws_security_group.db.id]
  deletion_protection           = var.deletion_protection
  skip_final_snapshot           = !var.deletion_protection
  final_snapshot_identifier     = var.deletion_protection ? "${var.name}-final" : null
  performance_insights_enabled  = true
}

resource "aws_db_instance" "replica" {
  count                  = var.replica_count
  identifier             = "${var.name}-replica-${count.index}"
  replicate_source_db    = aws_db_instance.primary.identifier
  instance_class         = var.instance_class
  storage_encrypted      = true
  kms_key_id             = var.kms_key_arn
  vpc_security_group_ids = [aws_security_group.db.id]
  skip_final_snapshot    = true
}

output "primary_endpoint" { value = aws_db_instance.primary.endpoint }
output "primary_arn" { value = aws_db_instance.primary.arn }
output "replica_endpoints" { value = aws_db_instance.replica[*].endpoint }
output "master_user_secret_arn" { value = aws_db_instance.primary.master_user_secret[0].secret_arn }
