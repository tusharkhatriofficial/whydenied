#!/usr/bin/env bash
# Publish the WhyDenied stack as a public, one-click CloudFormation template.
#
# Packages template.yaml with its Lambda code into an S3 bucket whose
# releases/ prefix is publicly readable, then prints the template URL used by
# the "Launch in AWS" button. Only objects under releases/ are public.
#
# Usage: AWS_PROFILE=whydenied scripts/publish-template.sh
set -euo pipefail

REGION="us-east-1"   # Lambda code must be in the same region as the stack
cd "$(dirname "$0")/.."

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
BUCKET="whydenied-releases-${ACCOUNT}-${REGION}"

if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "Creating bucket $BUCKET"
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
fi

# Allow a bucket policy that grants public read, but keep ACLs locked down.
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false

aws s3api put-bucket-policy --bucket "$BUCKET" --policy "$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "PublicReadReleases",
    "Effect": "Allow",
    "Principal": "*",
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::${BUCKET}/releases/*"
  }]
}
EOF
)"

sam build
sam package \
  --region "$REGION" \
  --s3-bucket "$BUCKET" \
  --s3-prefix releases/code \
  --output-template-file .aws-sam/packaged.yaml

aws s3 cp .aws-sam/packaged.yaml "s3://${BUCKET}/releases/whydenied.yaml" \
  --content-type text/yaml --region "$REGION"

URL="https://${BUCKET}.s3.${REGION}.amazonaws.com/releases/whydenied.yaml"
curl -fsS -o /dev/null "$URL" && echo "Template is publicly readable."
echo "$URL"
