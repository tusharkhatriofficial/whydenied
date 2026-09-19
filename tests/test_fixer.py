import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / "src" / "analyzer"))

import notify  # noqa: E402
from fixer import NoSafeFix, RoleNotFound, open_fix_pr  # noqa: E402
from github import GitHubError  # noqa: E402
from test_terraform import MAIN_TF, denial  # noqa: E402


class FakeGitHub:
    repo = "me/infra"

    def __init__(self, files=None, branch_exists=False, existing_pr=None):
        self.files = files if files is not None else {"infra/main.tf": MAIN_TF}
        self.branch_exists = branch_exists
        self.existing_pr = existing_pr
        self.created = {}
        self.prs = []

    def default_branch(self):
        return "main"

    def branch_sha(self, branch):
        return "sha1"

    def tf_files(self, ref):
        return self.files

    def create_branch(self, name, sha):
        if self.branch_exists:
            raise GitHubError(422, "Reference already exists")
        self.branch = name

    def create_file(self, path, content, branch, message):
        self.created[path] = content

    def find_pull_request(self, head):
        return self.existing_pr

    def open_pull_request(self, title, head, base, body):
        self.prs.append({"title": title, "head": head, "base": base, "body": body})
        return "https://github.com/me/infra/pull/1"


def test_opens_pr_with_fix_next_to_role():
    gh = FakeGitHub()
    url = open_fix_pr(denial(), gh)
    assert url == "https://github.com/me/infra/pull/1"
    assert list(gh.created) == ["infra/whydenied_ssm_getparameter_abc123.tf"]
    pr = gh.prs[0]
    assert pr["head"] == "whydenied/abc123def4567890"
    assert pr["base"] == "main"
    assert "ssm:GetParameter" in pr["title"]
    assert "aws_iam_role.orders_api" in pr["body"]


def test_retry_returns_existing_pr_instead_of_opening_another():
    gh = FakeGitHub(branch_exists=True, existing_pr="https://github.com/me/infra/pull/7")
    assert open_fix_pr(denial(), gh) == "https://github.com/me/infra/pull/7"
    assert gh.prs == []


def test_retry_after_partial_failure_adds_file_and_opens_pr():
    gh = FakeGitHub(branch_exists=True, existing_pr=None)
    assert open_fix_pr(denial(), gh) == "https://github.com/me/infra/pull/1"
    assert list(gh.created) == ["infra/whydenied_ssm_getparameter_abc123.tf"]


def test_role_not_in_repo():
    with pytest.raises(RoleNotFound):
        open_fix_pr(denial(principal_arn="arn:aws:iam::1:role/unknown"), FakeGitHub())


def test_explicit_deny_is_not_auto_fixed():
    gh = FakeGitHub()
    with pytest.raises(NoSafeFix):
        open_fix_pr(denial(reason="explicit_deny_scp"), gh)
    assert gh.created == {}


def test_alert_payloads_include_pr_link():
    s = notify.summary(denial(), "pr_open", "https://github.com/me/infra/pull/1")
    slack = notify.slack_payload(s)
    assert slack["blocks"][-1]["elements"][0]["url"] == "https://github.com/me/infra/pull/1"
    discord = notify.discord_payload(s)
    assert discord["embeds"][0]["url"] == "https://github.com/me/infra/pull/1"
    assert s["role"] == "orders-api-role"


def test_alert_without_pr_shows_reason():
    s = notify.summary(denial(), "needs_human", note="reason is 'explicit_deny_scp'")
    assert "explicit_deny_scp" in notify.slack_payload(s)["blocks"][-1]["elements"][0]["text"]
    assert "embeds" in notify.discord_payload(s)
