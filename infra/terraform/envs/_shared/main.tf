# Environment composition shared by staging and production. Each env
# directory symlinks this file and supplies its own backend + tfvars, so the
# two environments differ only in variables.

locals {
  name = "soroban-explorer-${var.environment}"
}

module "kms" {
  source = "../../modules/kms"
  name   = local.name
}

module "network" {
  source = "../../modules/network"
  name   = local.name
  cidr   = var.vpc_cidr
  azs    = var.azs
}

module "postgres" {
  source                = "../../modules/postgres"
  name                  = local.name
  vpc_id                = module.network.vpc_id
  vpc_cidr              = module.network.vpc_cidr
  subnet_ids            = module.network.private_subnet_ids
  kms_key_arn           = module.kms.key_arn
  instance_class        = var.db_instance_class
  allocated_storage     = var.db_allocated_storage
  backup_retention_days = var.db_backup_retention_days
  replica_count         = var.db_replica_count
  multi_az              = var.db_multi_az
  deletion_protection   = var.deletion_protection
}

module "redis" {
  source     = "../../modules/redis"
  name       = local.name
  vpc_id     = module.network.vpc_id
  vpc_cidr   = module.network.vpc_cidr
  subnet_ids = module.network.private_subnet_ids
  node_type  = var.redis_node_type
  replicas   = var.redis_replicas
}

module "kubernetes" {
  source              = "../../modules/kubernetes"
  name                = local.name
  subnet_ids          = module.network.private_subnet_ids
  kms_key_arn         = module.kms.key_arn
  kubernetes_version  = var.kubernetes_version
  node_instance_types = var.node_instance_types
  node_min            = var.node_min
  node_max            = var.node_max
  node_desired        = var.node_desired
}

module "storage" {
  source             = "../../modules/storage"
  name               = local.name
  kms_key_arn        = module.kms.key_arn
  export_expiry_days = var.export_expiry_days
}

module "cdn" {
  source          = "../../modules/cdn"
  name            = local.name
  domain          = var.domain
  origin_domain   = var.ingress_origin_domain
  certificate_arn = var.certificate_arn
}

module "dns" {
  source         = "../../modules/dns"
  zone_name      = var.dns_zone
  record_name    = var.domain
  target_domain  = module.cdn.domain_name
  target_zone_id = module.cdn.hosted_zone_id
}

module "monitoring" {
  source         = "../../modules/monitoring"
  name           = local.name
  db_instance_id = local.name
}

output "cluster_name" { value = module.kubernetes.cluster_name }
output "db_endpoint" { value = module.postgres.primary_endpoint }
# Secret reference only; the password itself lives in Secrets Manager.
output "db_master_secret_arn" { value = module.postgres.master_user_secret_arn }
output "redis_endpoint" { value = module.redis.primary_endpoint }
output "exports_bucket" { value = module.storage.exports_bucket }
output "backups_bucket" { value = module.storage.backups_bucket }
output "alerts_topic_arn" { value = module.monitoring.alerts_topic_arn }
