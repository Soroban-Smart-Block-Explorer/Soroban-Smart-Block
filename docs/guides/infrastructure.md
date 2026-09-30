# Infrastructure as Code (Terraform)

All staging and production infrastructure is defined in `infra/terraform/`.
Changes are reviewed as pull requests; nothing is created by hand.

## Layout

```
infra/terraform/
  modules/         network, postgres, redis, kubernetes, storage, cdn, dns, kms, monitoring
  envs/_shared/    the composition (main.tf, variables.tf, providers.tf)
  envs/staging/    backend.tf + terraform.tfvars (+ symlinks to _shared)
  envs/production/ backend.tf + terraform.tfvars (+ symlinks to _shared)
  dr/              cross-region disaster recovery (see disaster-recovery.md)
```

Staging and production are built from the same modules; only `terraform.tfvars`
differs (sizes, replica counts, retention, deletion protection).

| Module | Provides |
|---|---|
| `network` | VPC, public/private subnets, NAT |
| `postgres` | RDS Postgres 16, PITR via backup retention, read replicas, KMS encryption |
| `redis` | ElastiCache Redis (rate limits, cache, ingest leader election) |
| `kubernetes` | EKS cluster, node group, OIDC provider for IRSA |
| `storage` | S3 buckets for exports and backups (versioned, private, KMS) |
| `cdn` | CloudFront; `/api/*` uncached |
| `dns` | Route 53 alias to the CDN |
| `kms` | Rotating customer-managed key |
| `monitoring` | CloudWatch alarms → SNS topic |

## Secrets

No secret values live in Terraform state. The RDS master password is generated
by RDS (`manage_master_user_password`) and stored in Secrets Manager; Terraform
only outputs the secret ARN. Application secrets are referenced from Vault/KMS
(`indexer/src/secrets`) and synced into the cluster by External Secrets.

## Bootstrapping remote state (once)

```bash
aws s3api create-bucket --bucket soroban-explorer-tfstate --region us-east-1
aws s3api put-bucket-versioning --bucket soroban-explorer-tfstate \
  --versioning-configuration Status=Enabled
aws dynamodb create-table --table-name soroban-explorer-tflock \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH --billing-mode PAY_PER_REQUEST
```

## Applying

```bash
cd infra/terraform/envs/staging
terraform init
terraform apply
```

Staging is fully reproducible from scratch with this command.

## CI (`.github/workflows/infra.yml`)

- **Policy**: `terraform fmt`, tfsec (HIGH+), and checkov on every run.
- **Plan on PRs**: a plan for each environment is posted as a PR comment.
- **Apply on merge**: staging applies first; production waits for a manual
  approval on the `production` GitHub environment.
- **Drift detection**: daily `terraform plan -detailed-exitcode`; exit code 2
  opens an issue labelled `drift` and fails the job.
- **Credentials**: GitHub OIDC assumes `TF_PLAN_ROLE_<env>` (read-only) or
  `TF_APPLY_ROLE_<env>` repository variables. No static AWS keys.

### Drift detection drill

1. In the staging account, change a managed resource by hand, e.g. add a tag
   to the exports bucket or change the Redis node type.
2. Trigger `Infra — Terraform` manually (`workflow_dispatch` runs the drift
   job) or wait for the daily cron.
3. The job exits with code 2 and opens a `drift` issue containing the diff.
4. Revert by running `terraform apply` (or codify the change in a PR).

## Importing existing hand-made resources

Resources created before this change must be imported, not recreated:

1. Write the resource in the module as it exists today (match names/sizes).
2. Add an `import` block in the environment, for example:

   ```hcl
   import {
     to = module.postgres.aws_db_instance.primary
     id = "soroban-explorer-production"
   }
   ```

3. Run `terraform plan`. It must show `import` and **no** `replace`/`destroy`
   actions; adjust the code until the plan is a no-op apart from the import.
4. Apply, then delete the `import` block in a follow-up PR.

Import order: KMS → network → Postgres → Redis → EKS → S3 → CDN → DNS →
monitoring, so that dependencies exist in state before their consumers.
