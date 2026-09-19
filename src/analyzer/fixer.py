"""Turn a Denial into a pull request against the repo that defines the role."""

from github import GitHubError
from terraform import NoSafeFix, find_role, fix_filename, render_fix, role_name_from_arn


class RoleNotFound(Exception):
    pass


def open_fix_pr(denial, gh):
    """Open (or find the existing) fix PR for this denial. Returns the PR URL."""
    base = gh.default_branch()
    base_sha = gh.branch_sha(base)

    role_name = role_name_from_arn(denial.principal_arn)
    role = find_role(gh.tf_files(base_sha), role_name)
    if role is None:
        raise RoleNotFound(f"no aws_iam_role with name = \"{role_name}\" in {gh.repo}")

    hcl = render_fix(denial, role)  # raises NoSafeFix for things we won't auto-fix
    path = _beside(role.path, fix_filename(denial))
    branch = f"whydenied/{denial.id}"

    try:
        gh.create_branch(branch, base_sha)
    except GitHubError as e:
        if e.status != 422:  # 422 = branch already exists, e.g. a retried invocation
            raise
        existing = gh.find_pull_request(branch)
        if existing:
            return existing

    try:
        gh.create_file(path, hcl, branch, f"Allow {denial.action} for {role_name}")
    except GitHubError as e:
        if e.status != 422:  # 422 = file already on the branch from an earlier attempt
            raise

    return gh.open_pull_request(
        title=f"WhyDenied: allow {denial.action} for {role_name}",
        head=branch,
        base=base,
        body=pr_body(denial, role, path),
    )


def pr_body(denial, role, path):
    return f"""### What happened

`{denial.principal_arn}` was denied **`{denial.action}`** on

```
{denial.resource}
```

AWS said: *{_reason_text(denial)}*

First seen {denial.event_time} in `{denial.region}`.

### The fix

Adds `{path}`, an inline policy on `{role.address}` that allows **only** `{denial.action}` on **only** that resource. Nothing else about the role changes.

### Before merging

- [ ] The role *should* be able to do this. If not, close this PR and fix the caller instead.
- [ ] Run `terraform plan` and check the only change is this one policy.

---
Opened automatically by [WhyDenied](https://github.com/tusharkhatriofficial/whydenied).
"""


def _reason_text(denial):
    message = denial.error_message
    return message[message.find("because"):] if "because" in message else denial.reason


def _beside(role_path, filename):
    """Put the fix in the same directory as the file that defines the role."""
    directory = role_path.rsplit("/", 1)[0] if "/" in role_path else ""
    return f"{directory}/{filename}" if directory else filename


__all__ = ["open_fix_pr", "pr_body", "RoleNotFound", "NoSafeFix"]
