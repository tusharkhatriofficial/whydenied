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
- [ ] IAM user `whydenied-dev` with an access key; save it locally with `aws configure --profile whydenied` (never paste keys into a chat)
- [ ] `brew install awscli aws-sam-cli terraform`
- [ ] Bedrock: use a Claude model once in the console playground (fill in Anthropic's use-case form if asked)
- [ ] Ask on the WeMakeDevs Discord or FAQ whether AI coding assistants are allowed

## Checks to do first (hour one)

These can change the design, so do them before writing features.

- [ ] **Read-only denials:** does a denied `Get*`/`List*`/`Describe*` call reach EventBridge? If it doesn't, make the demo's denied call a write call, or set up the rule to receive read-only events.
- [ ] **Delay:** time how long a denial takes to go from CloudTrail to EventBridge. That decides whether the demo can run live or needs a recording.
- [ ] **Error details:** check that the CloudTrail event includes the principal ARN, the action and the resource for the service used in the demo. Some services (S3, SQS) give very little detail.

## Friday: from catching the error to explaining it

- [ ] SAM project skeleton: EventBridge rule → Lambda → DynamoDB
- [ ] Demo target: Terraform app (a Lambda plus a role that's missing one permission)
- [ ] Lambda reads the event, extracts principal, action and resource, and saves it with dedupe (hash of principal + action + resource, with a count)
- [ ] Policy simulator check: confirm the action is missing from the identity policy

## Saturday: from explanation to pull request

- [ ] GitHub App (or a fine-grained token for the MVP): search the repo for the role's `name`
- [ ] Bedrock prompt: given the Terraform file and the missing action and resource, return the smallest change (no `*`) plus an explanation
- [ ] Check the change: the Terraform must still parse, and the new statement must only add the missing action on the specific resource
- [ ] Open a PR with the explanation as its description
- [ ] Slack alert with a link to the PR

## Sunday: dashboard, demo, submission

- [ ] API Gateway plus a small React dashboard on Amplify: list of denials, how many times each happened, their status, PR links
- [ ] **By about 3 PM, stop adding features**
- [ ] Record the demo: call the app → it's denied → Slack alert → PR appears → merge → `terraform apply` → call again → it works
- [ ] Writeup and README tidy-up; list credits and licences
- [ ] Submit well before the deadline

## Risks

| Risk | What to do |
|---|---|
| CloudTrail delay makes the live demo slow | Pre-record the waiting part; trigger it live in the video |
| Read-only denials don't reach EventBridge | Use a write action in the demo |
| Bedrock produces an overly broad or broken change | Check the change in code; refuse `*`; fall back to a generated statement template |
| Running out of time | The dashboard is optional; Slack plus the PR is a complete demo |
| AWS costs | $20 budget alert; no S3 data events; `sam delete` afterwards |

## After the hackathon

- [ ] Delete the IAM access key
- [ ] `sam delete` and `terraform destroy` on the demo target
