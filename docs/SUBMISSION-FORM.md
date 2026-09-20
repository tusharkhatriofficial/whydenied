# First Commit submission form: answers

Solo entry. Fill the blanks marked TODO before submitting.

## Links and identity

| Field | Value |
|---|---|
| Team leader's WeMakeDevs username | TODO (from wemakedevs.org/home) |
| Team leader's GitHub | https://github.com/tusharkhatriofficial |
| Team leader's LinkedIn | TODO |
| Team leader's resume | TODO (public Google Drive link; needed for Amazon Fast Track interviews) |
| Members 2 to 4 | Leave blank |
| Project title | WhyDenied |
| Track | Ship It |
| GitHub link to project | https://github.com/tusharkhatriofficial/whydenied |
| Deployed link | https://main.d2nltux9t41fs1.amplifyapp.com |
| YouTube video demo link | TODO |
| Blog links | Optional. Leave blank unless you publish on AWS Builder Center |

Track note: Ship It fits, because the project is deployed on AWS with a live URL. Every submission is considered for Best UI as well.

## What does your project do?

WhyDenied turns AWS `AccessDenied` errors into reviewed pull requests against your Terraform.

Least privilege is the rule every team agrees with and few sustain. Each new feature, renamed resource or environment difference produces a fresh denial, and fixing one properly means reading the error, working out which policy blocked it, finding the Terraform that defines the role, and opening a pull request. That is 30 to 60 minutes of engineering time, so people take shortcuts: they fix it by hand in the console, which the next `terraform apply` silently reverts, or they grant `"Action": "*"` and leave it there forever. The errors also surface where nobody is watching, in Lambda logs, CI output and cron jobs, so the same denial repeats hundreds of times before anyone reacts.

WhyDenied watches CloudTrail for denied calls, identifies the role, action, resource and reason, groups repeats into one issue, and opens a pull request that grants exactly that action on exactly that resource. An AI model adds review notes: whether the access looks expected, the risk, and what to check. A human merges. Nothing touches IAM without that merge.

It is for platform, DevOps and backend engineers who own Terraform-managed AWS accounts, and for small teams who want tight roles without paying for them in daily interruptions. Roles can start minimal and grow one reviewed permission at a time.

It is self-hosted, so it runs in the user's own account and their CloudTrail data, IAM details and tokens never leave it. The live page lets anyone paste an error and see the Terraform it would write, check which roles in a public repository it can match, and install it in one click.

## How did you use AWS in your project?

Ship it. The project is built on AWS services end to end and deployed to a live URL.

- **AWS CloudTrail:** the source of every denial. A multi-region trail records management events.
- **Amazon EventBridge:** a rule matches `AccessDenied` and `UnauthorizedOperation` events. Its state is `ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS`, which was necessary because EventBridge drops read-only denials by default.
- **AWS Lambda:** two functions on Python 3.14 and arm64. The analyzer parses the denial, deduplicates it, generates the Terraform fix and opens the pull request. A second function serves the public API behind the setup page.
- **Amazon DynamoDB:** one item per (role, action, resource) with a count, status and pull request link. A conditional update guarantees only one invocation opens a pull request, so retries never create duplicates.
- **AWS Systems Manager Parameter Store:** SecureString storage for the GitHub token, AI key and chat webhooks, read by the analyzer with a policy scoped to `/whydenied/*`.
- **Amazon Bedrock:** a supported provider for the AI review notes, selected with one stack parameter (`AIProvider=bedrock`).
- **Amazon API Gateway:** an HTTP API with CORS and route throttling for the three public endpoints.
- **AWS Amplify Hosting:** hosts the setup page, deployed through the manual deployment API.
- **Amazon S3 and AWS CloudFormation:** the packaged template is published to a public S3 prefix so anyone can install WhyDenied into their own account through a CloudFormation quick-create link.
- **AWS SAM:** the whole stack is infrastructure as code, deployed with `sam build` and `sam deploy`.
- **IAM policy simulator:** used while developing to confirm which policy type was blocking a call.

## Team leader's contributions

Solo entry, so everything below is mine.

- Researched existing tools (Access Undenied, Amazon Q console diagnosis, IAM Policy Autopilot, the AWS Support runbook) and positioned the project at the gap they leave: none of them delivers the fix as a pull request against your infrastructure code.
- Ran timing and behaviour experiments before writing features: proved that EventBridge drops read-only denials unless the rule opts in, measured 20 to 25 second delivery, and confirmed which fields the event provides.
- Built the analyzer: CloudTrail event parsing, role resolution from the session ARN, denial classification, and deduplication in DynamoDB with a conditional claim so only one pull request is opened.
- Built the fix generator: locating the `aws_iam_role` in Terraform and rendering the exact policy in code rather than with a model, with explicit refusals for explicit denies, SCPs and wildcard actions.
- Built the GitHub integration: branch, commit, pull request with a reviewer checklist, and idempotent retries.
- Added the AI review layer with a switchable provider and validated, markup-stripped output.
- Built the public setup page and its API: paste an error and get the fix, check a public repository's roles, one-click install, and a live feed of real denials.
- Wrote the deployment tooling: the SAM stacks, the public release template and the Amplify deployment script.
- 60 unit tests, including tests against real captured CloudTrail events.

## Feedback on the AWS services you used

**Amazon EventBridge.** Read-only management events from CloudTrail are excluded unless a rule's state is `ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS`. This is a silent default: the rule matches nothing, no error appears, and CloudTrail clearly shows the event. I only found it because I tested a read call and a write call side by side before building anything. The opt-in is free, which makes the default harder to justify. At minimum the EventBridge console should warn when a rule pattern targets CloudTrail events while the state excludes read-only ones.

**Amazon Bedrock.** On a new AWS India (AISPL) account, every model returned `ValidationException: Operation not allowed`, including Amazon Nova, while the console returned a 403 saying the model "is not available for this account". Neither message says what to do, and they disagree with each other. The actual cause appears to be that Anthropic models are AWS Marketplace products and the account had only UPI AutoPay as a payment method. Nothing in the Bedrock console surfaces that link, so I spent time on a support case instead of building. An explicit message such as "this account cannot subscribe to Marketplace models with its current payment method" would have saved hours.

**AWS CloudTrail.** The split between management and data events is reasonable, but it is easy to build on the assumption that all denials are visible. S3 `GetObject` and DynamoDB `GetItem` denials, which are what application teams hit most, need data event logging that is billed separately. Being able to log only failed data events, or only a specific error code, would make this affordable for exactly this kind of use case.

**AWS CloudFormation and Systems Manager.** `AWS::SSM::Parameter` still cannot create a SecureString, so a stack that needs a secret has to send users to the CLI or add a custom resource. For a one-click install this is the weakest part of the flow.

**AWS SAM.** `sam build` requires a local Python matching the Lambda runtime, and the error only appears after the build starts. Checking the runtime up front, or falling back to container builds automatically, would be friendlier.

**Amplify Hosting.** Deploying a plain static folder without connecting a Git repository works well, but it takes four CLI calls plus a zip upload and polling for the job status. A single `amplify deploy ./dist` command would remove a lot of scripting.

## What did you like about the AWS services you used

**CloudTrail with EventBridge.** Once read-only events were enabled, this pairing is excellent. Every denied API call in the account arrives at a Lambda about 20 seconds later, with the caller identity, action, resource and AWS's own explanation, and I wrote no polling code at all. The whole product rests on that, and the first management trail being free makes it realistic for a student to build on.

**AWS Lambda.** Python 3.14 on arm64, 22 ms cold runs, and boto3 already in the runtime meant the analyzer needed zero dependencies. The event-driven model fits this problem exactly.

**Amazon DynamoDB.** Conditional updates are what make the tool safe. A single `UpdateExpression` with `ADD` for the counter and `if_not_exists` for first-seen values does deduplication in one call, and a conditional status change from "new" to "fixing" guarantees only one invocation opens a pull request. On-demand billing meant no capacity planning.

**AWS SAM.** `sam build`, `sam deploy --guided` and `sam validate --lint` gave me a reviewable changeset before every deploy, and the policy templates such as `DynamoDBCrudPolicy` and `SSMParameterWithSlashPrefixReadPolicy` made least privilege for my own stack the easy path rather than the careful one. `sam package` plus a public S3 object also gave me one-click installs for other people with no extra work.

**Systems Manager Parameter Store.** SecureString parameters on the standard tier are free, and decryption with the AWS managed key needs no extra IAM setup. For a tool that holds a GitHub token and an API key, this was the simplest secure option available.

**IAM error messages.** Recent messages say precisely why a call failed, for example "because no identity-based policy allows the ssm:GetParameter action". That sentence is what lets WhyDenied classify a denial reliably instead of guessing, and it is a real improvement over the older opaque errors.

**Documentation.** The EventBridge page on read-only management events and the SAM policy template reference were both accurate and answered exactly what I needed.
