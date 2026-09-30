# Remote state in S3 with DynamoDB locking; bucket/table are bootstrapped once
# (see docs/guides/infrastructure.md).
terraform {
  backend "s3" {
    bucket         = "soroban-explorer-tfstate"
    key            = "staging/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "soroban-explorer-tflock"
    encrypt        = true
  }
}
