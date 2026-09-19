# Build plan

Hackathon window: 17–20 September 2026. **Check the exact submission deadline on the event page. The form closes at that deadline, with no late entries.**

## What we submit

The rules require all three of these:

- [ ] Public GitHub repo, with a commit history that matches the event dates
- [ ] Demo video, 3 minutes maximum, on YouTube, **showing AWS on screen** (naming it in the writeup isn't enough)
- [ ] Short writeup: the problem, how it's built, how it uses AWS
- [ ] Optional: blog post (separate Best Blog prize)

Judges score: real problem and impact · meaningful use of AWS · what you learned · working product over polish · the demo video.

## Day 0: setup (Friday 18)

- [ ] Root account: turn on MFA, create a $20 budget with an email alert
- [x] IAM user `whydenied-dev` with an access key; save it locally with `aws configure --profile whydenied` (never paste keys into a chat)
- [x] `brew install awscli aws-sam-cli terraform`
- [ ] Bedrock: use a Claude model once in the console playground (fill in Anthropic's use-case form if asked)
- [ ] Ask on the WeMakeDevs Discord or FAQ whether AI coding assistants are allowed

## Checks to do first (hour one)

These can change the design, so do them before writing features.

- [x] **Read-only denials:** by default they **don't** reach EventBridge. CloudTrail records them, but EventBridge only delivers write calls. Fix: set the rule's state to `ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS` (free, opt-in). Tested 18 Sep with `dynamodb:ListTables`: not delivered before the change, delivered after.
- [x] **Delay:** about **20–25 seconds** from the call to the event arriving (`sqs:CreateQueue` 24s, `dynamodb:ListTables` 20s). A live demo is realistic.
- [x] **Error details:** checked for SQS and DynamoDB. Each event gives:
  - the role ARN, in `userIdentity.sessionContext.sessionIssuer.arn`. We match this against the Terraform code.
  - the action, resource and denial reason in `errorMessage`, e.g. *"not authorized to perform: dynamodb:ListTables on resource: arn:…:table/\* because no identity-based policy allows…"*.
  - Watch out: SQS writes the action in lower case (`sqs:createqueue`). Build the action from `eventSource` plus `eventName` instead.

- [x] **Data events:** everyday app calls like S3 `GetObject`, DynamoDB `GetItem` and SQS `SendMessage` are CloudTrail **data events**. Our trail only records management events, so it doesn't see those denials. Catching them means turning on data events, which AWS charges for. The demo therefore uses `ssm:GetParameter`, a management event. Mention this limit in the writeup.
- [ ] **Bedrock:** every model returns `Operation not allowed`. The account is billed by AWS India (AISPL) and pays with UPI only, and Marketplace models may need a card. A support case is open. Fix generation doesn't depend on Bedrock; it only writes the explanation.

## Friday: from catching the error to explaining it

- [x] SAM project skeleton: EventBridge rule → Lambda → DynamoDB
- [x] Demo target: Terraform app (a Lambda plus a role that's missing one permission). Repo: `whydenied-demo-infra`
- [x] Lambda reads the event, extracts principal, action and resource, and saves it with dedupe (hash of principal + action + resource, with a count)
- [ ] ~~Policy simulator check~~ Skipped for now: the `errorMessage` already states the reason (e.g. "no identity-based policy allows").

## Saturday: from explanation to pull request

- [x] Find the role in the Terraform code by its `name` (`terraform.py`)
- [ ] GitHub access: fine-grained token, limited to `whydenied-demo-infra`, stored in SSM as a SecureString
- [x] Fix generator: writes the exact missing permission as a new `.tf` file, in code rather than with AI; refuses explicit denies and wildcards
- [ ] Bedrock (only if the account is unlocked in time): a plain-English explanation for the PR description
- [x] Check the change: generated file passes `terraform validate` against the demo repo
- [ ] Open a PR with the explanation as its description
- [ ] Team alerts with a link to the PR, sent to **Slack and/or Discord**:
  - both use incoming webhooks, so the setup is just a URL per channel
  - the webhook URLs are stored in SSM Parameter Store as SecureStrings, because anyone holding one can post to the channel
  - one alert per new denial, not per repeat; repeats only bump the count
  - Discord messages are formatted as embeds, Slack messages as Block Kit

## Sunday: dashboard, demo, submission

- [ ] API Gateway plus a small React dashboard on Amplify: list of denials, how many times each happened, their status, PR links
- [ ] **By about 3 PM, stop adding features**
- [ ] Record the demo: call the app → it's denied → Slack/Discord alert → PR appears → merge → `terraform apply` → call again → it works
- [ ] Writeup and README tidy-up; list credits and licences
- [ ] Submit well before the deadline

## Risks

| Risk | What to do |
|---|---|
| CloudTrail delay makes the live demo slow | Pre-record the waiting part; trigger it live in the video |
| Read-only denials don't reach EventBridge | Use a write action in the demo |
| Bedrock produces an overly broad or broken change | Check the change in code; refuse `*`; fall back to a generated statement template |
| Running out of time | The dashboard is optional; a Slack/Discord alert plus the PR is a complete demo |
| AWS costs | $20 budget alert; no S3 data events; `sam delete` afterwards |

## After the hackathon

- [ ] Delete the IAM access key
- [ ] `sam delete` and `terraform destroy` on the demo target
