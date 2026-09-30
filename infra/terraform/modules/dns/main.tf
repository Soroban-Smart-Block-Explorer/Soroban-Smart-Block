# Route 53 alias record pointing the public hostname at the CDN.
variable "zone_name" { type = string }
variable "record_name" { type = string }
variable "target_domain" { type = string }
variable "target_zone_id" { type = string }

data "aws_route53_zone" "this" {
  name = var.zone_name
}

resource "aws_route53_record" "this" {
  zone_id = data.aws_route53_zone.this.zone_id
  name    = var.record_name
  type    = "A"
  alias {
    name                   = var.target_domain
    zone_id                = var.target_zone_id
    evaluate_target_health = false
  }
}

output "fqdn" { value = aws_route53_record.this.fqdn }
