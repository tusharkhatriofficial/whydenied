# Demo video script

Under 3 minutes. AWS has to be on screen, not just mentioned.

## Before recording

1. **Terminal** in `~/core/whydenied-demo-infra`, big font, `export AWS_PROFILE=whydenied` done, scrollback cleared.
2. **Tabs, left to right:** the live page, CloudTrail event history, the DynamoDB table, Discord, the demo repo's pull requests.
3. **Check:** the feed shows one denial, `ssm:GetParameter`, PR open. Do not run the `{"mode":"list"}` command yet. Only the first sighting opens a pull request.
4. 1080p, mic tested, notifications off.

The pull request takes 20 to 30 seconds to appear. Use the CloudTrail and DynamoDB tabs to fill it.

## Script

The lines below are how you'd say it, not a paragraph to read out. Say it your way.

### 0:00  The problem
**Live page.**

> Everyone on AWS has hit AccessDenied. And fixing it properly is annoying: find the policy, find the Terraform, open a PR. So people just click it in the console, or slap a wildcard on it.
>
> This does it in thirty seconds.

### 0:20  Break it
**Terminal.**

```bash
aws lambda invoke --function-name orders-api \
  --payload '{"mode":"list"}' --cli-binary-format raw-in-base64-out out.json && cat out.json
```

> This Lambda reads its settings from Parameter Store. Its role can't. There's the denial.
>
> Nothing's staged. WhyDenied has never seen this one.

### 0:40  AWS sees it
**CloudTrail, open the event, point at `errorCode` and the role.**

> CloudTrail logs the failed call, and an EventBridge rule picks up the denials.
>
> One thing I learned the hard way: EventBridge skips read-only denials unless you opt in. That's half of them.

### 1:05  One issue, not five hundred
**DynamoDB, the new row.**

> A Lambda pulls out the role, the action, the resource. One row each, with a count. Same error five hundred times is still one row, and one PR.

### 1:25  The team gets told
**Discord.**

> One alert, with a link.

### 1:40  The fix
**The new PR. Files changed, then back to the description.**

> One file. That one action, on that one path. No wildcard.
>
> The AI notes underneath say what the app was doing and what to check. That's all the model does. The policy itself is written by code, so the AI can't widen anything.

### 2:10  Merge it
**Click Merge, then terminal.**

```bash
git pull
terraform apply -auto-approve
aws lambda invoke --function-name orders-api \
  --payload '{"mode":"list"}' --cli-binary-format raw-in-base64-out out.json && cat out.json
```

> I approve it, apply it, and the app works. And the code matches the account, because the fix went through the repo.

### 2:30  Your turn
**Live page: paste an error in step 1, then step 3.**

> Same parser runs here, so you can paste your own error and see what it'd write. It'll check your repo's roles too, and install into your account in one click.
>
> It runs in your account. Your CloudTrail, your tokens, nothing leaves.

### 2:55  Close

> Least privilege, but actually doable. Start tight, add one reviewed permission at a time.

## If it goes wrong

| Problem | Do this |
|---|---|
| No PR after 60 seconds | `aws logs tail /aws/lambda/whydenied-analyzer --since 5m`. Keep talking over CloudTrail. |
| Denial already recorded | `aws dynamodb delete-item --table-name whydenied-denials --key "{\"id\":{\"S\":\"<id>\"}}"`, invoke again. |
| Apply wants extra changes | Accept it if it's only the new policy, or `-target` the policy. |
| Discord slow | Skip it. The PR is the point. |
| Over 3 minutes | Cut DynamoDB, mention the counting over CloudTrail. |

## After

- YouTube, public or unlisted: "WhyDenied: AWS AccessDenied to a reviewed pull request".
- Link goes at the top of `docs/SUBMISSION.md` and in the form.
