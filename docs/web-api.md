# Web API contract

Backend for the setup page. Deployed as a separate stack (`web/template.yaml`, stack name `whydenied-web`) so that installing WhyDenied never adds public endpoints to a user's account.

Base URL is provided to the page as `window.WHYDENIED_API` in `site/config.js` (no trailing slash). All responses are JSON. CORS allows any origin for GET and POST.

## POST /try

Parse a pasted AccessDenied error message and render the fix. No AI call.

Request:
```json
{ "error": "User: arn:aws:sts::123456789012:assumed-role/orders-api-role/orders-api is not authorized to perform: ssm:GetParameter on resource: arn:aws:ssm:us-east-1:123456789012:parameter/app/db because no identity-based policy allows the ssm:GetParameter action" }
```
The message may be embedded in surrounding text, such as `An error occurred (AccessDeniedException) when calling the GetParameter operation: User: ...`. Maximum 4000 characters.

Response 200:
```json
{
  "denial": {
    "principal_arn": "arn:aws:iam::123456789012:role/orders-api-role",
    "principal_type": "role",
    "role_name": "orders-api-role",
    "action": "ssm:GetParameter",
    "resource": "arn:aws:ssm:us-east-1:123456789012:parameter/app/db",
    "reason": "missing_identity_allow",
    "reason_text": "No identity-based policy allows this action."
  },
  "fixable": true,
  "fix": { "filename": "whydenied_ssm_getparameter_1a2b3c.tf", "hcl": "resource \"aws_iam_role_policy\" ..." },
  "note": "The role address aws_iam_role.orders_api_role is inferred from the role name. In a real run WhyDenied reads it from your repository."
}
```
When not fixable (explicit deny, SCP, user or root caller, wildcard): `"fixable": false`, `"fix": null`, and `"note"` explains why in one sentence.

`principal_type` is one of `role`, `user`, `root`, `unknown`.

Response 400: `{ "error": "<one sentence>" }` when no AccessDenied message can be found or the input is too long.

## POST /check

Report which IAM roles in a set of Terraform files WhyDenied can match. The page fetches the `.tf` files of a public GitHub repository in the browser and posts their contents.

Request:
```json
{ "files": { "infra/main.tf": "resource \"aws_iam_role\" \"orders_api\" { name = \"orders-api-role\" ... }" } }
```
Limits: at most 200 files, 1 MB total.

Response 200:
```json
{
  "roles": [
    { "address": "aws_iam_role.orders_api", "name": "orders-api-role", "path": "infra/main.tf", "ready": true, "issue": null },
    { "address": "aws_iam_role.worker", "name": null, "path": "infra/worker.tf", "ready": false, "issue": "Uses name_prefix. Set an explicit name so WhyDenied can match denials to this role." }
  ],
  "summary": { "total": 2, "ready": 1 }
}
```
Issues to detect: `name_prefix`, name from a variable or expression (`name = var.x`, `name = "${...}"`, `name = local.x`), no name at all (Terraform generates a random name).

## GET /feed

Recent denials from the demo account, newest first, at most 20.

Response 200:
```json
{
  "denials": [
    {
      "action": "ssm:GetParameter",
      "role_name": "orders-api-role",
      "resource": "arn:aws:ssm:us-east-1:123456789012:parameter/demo/orders-api/db-url",
      "status": "pr_open",
      "pr_url": "https://github.com/tusharkhatriofficial/whydenied-demo-infra/pull/1",
      "seen_count": 1,
      "first_seen": "2026-09-19T15:32:54Z",
      "last_seen": "2026-09-19T15:32:54Z"
    }
  ],
  "updated_at": "2026-09-19T16:00:00Z"
}
```
Only these fields are returned. Denials whose caller is not an IAM role are excluded.
