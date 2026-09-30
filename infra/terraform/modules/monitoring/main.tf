# Baseline CloudWatch alarms routed to an SNS topic (PagerDuty/email
# subscriptions are added out of band so endpoints stay out of state).
variable "name" { type = string }
variable "db_instance_id" { type = string }

resource "aws_sns_topic" "alerts" {
  name = "${var.name}-alerts"
}

resource "aws_cloudwatch_metric_alarm" "db_cpu" {
  alarm_name          = "${var.name}-db-cpu"
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { DBInstanceIdentifier = var.db_instance_id }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "db_storage" {
  alarm_name          = "${var.name}-db-free-storage"
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  dimensions          = { DBInstanceIdentifier = var.db_instance_id }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10737418240
  comparison_operator = "LessThanThreshold"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

output "alerts_topic_arn" { value = aws_sns_topic.alerts.arn }
