#!/usr/bin/env bash
# Deploy the setup page: the web API stack (web/template.yaml) and the static
# site on Amplify Hosting. Prints the live URL.
#
# Usage: AWS_PROFILE=whydenied TEMPLATE_URL=<from publish-template.sh> scripts/deploy-web.sh
set -euo pipefail

REGION="us-east-1"
APP_NAME="whydenied"
BRANCH="main"
cd "$(dirname "$0")/.."

# 1. Web API
sam build --template-file web/template.yaml --build-dir web/.aws-sam/build
sam deploy \
  --template-file web/.aws-sam/build/template.yaml \
  --stack-name whydenied-web \
  --region "$REGION" \
  --resolve-s3 \
  --capabilities CAPABILITY_IAM \
  --no-confirm-changeset \
  --no-fail-on-empty-changeset

API_URL=$(aws cloudformation describe-stacks --stack-name whydenied-web --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)
API_URL="${API_URL%/}"
echo "API: $API_URL"

# 2. Site bundle with the real config
DIST=$(mktemp -d)
cp -R site/. "$DIST/"
cat > "$DIST/config.js" <<EOF
window.WHYDENIED_API = "${API_URL}";
window.WHYDENIED_TEMPLATE_URL = "${TEMPLATE_URL:-}";
EOF
ZIP="$DIST.zip"
(cd "$DIST" && zip -qr "$ZIP" .)

# 3. Amplify Hosting (manual deployment, no Git connection needed)
APP_ID=$(aws amplify list-apps --region "$REGION" \
  --query "apps[?name=='${APP_NAME}'].appId | [0]" --output text)
if [ "$APP_ID" = "None" ] || [ -z "$APP_ID" ]; then
  APP_ID=$(aws amplify create-app --name "$APP_NAME" --platform WEB --region "$REGION" \
    --query app.appId --output text)
  aws amplify create-branch --app-id "$APP_ID" --branch-name "$BRANCH" --region "$REGION" >/dev/null
fi

read -r JOB_ID UPLOAD_URL < <(aws amplify create-deployment --app-id "$APP_ID" --branch-name "$BRANCH" \
  --region "$REGION" --query "[jobId, zipUploadUrl]" --output text)
curl -fsS -H "Content-Type: application/zip" --upload-file "$ZIP" "$UPLOAD_URL"
aws amplify start-deployment --app-id "$APP_ID" --branch-name "$BRANCH" --job-id "$JOB_ID" \
  --region "$REGION" >/dev/null

for _ in $(seq 1 30); do
  STATUS=$(aws amplify get-job --app-id "$APP_ID" --branch-name "$BRANCH" --job-id "$JOB_ID" \
    --region "$REGION" --query job.summary.status --output text)
  [ "$STATUS" = "SUCCEED" ] && break
  [ "$STATUS" = "FAILED" ] && { echo "Amplify deployment failed" >&2; exit 1; }
  sleep 5
done

rm -rf "$DIST" "$ZIP"
echo "Live: https://${BRANCH}.${APP_ID}.amplifyapp.com"
