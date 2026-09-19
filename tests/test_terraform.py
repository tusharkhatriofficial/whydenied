import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / "src" / "analyzer"))

from parse import Denial  # noqa: E402
from terraform import NoSafeFix, find_role, fix_filename, list_roles, render_fix, role_name_from_arn  # noqa: E402

MAIN_TF = '''
resource "aws_iam_role" "orders_api" {
  name               = "orders-api-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags = {
    team = "orders"
  }
}

resource "aws_iam_role" "billing" {
  name = "billing-role"
}
'''


def denial(**overrides):
    values = dict(
        id="abc123def4567890",
        principal_arn="arn:aws:iam::123456789012:role/orders-api-role",
        action="ssm:GetParameter",
        resource="arn:aws:ssm:us-east-1:123456789012:parameter/demo/orders-api/db-url",
        reason="missing_identity_allow",
        error_code="AccessDenied",
        error_message="...",
        read_only=True,
        region="us-east-1",
        event_time="2026-09-19T05:00:00Z",
        event_id="e1",
    )
    values.update(overrides)
    return Denial(**values)


def test_role_name_from_arn_handles_paths():
    assert role_name_from_arn("arn:aws:iam::1:role/orders-api-role") == "orders-api-role"
    assert role_name_from_arn("arn:aws:iam::1:role/service/team/orders-api-role") == "orders-api-role"


def test_find_role_by_name():
    files = {"infra/main.tf": MAIN_TF, "README.md": 'name = "orders-api-role"'}
    loc = find_role(files, "orders-api-role")
    assert loc.path == "infra/main.tf"
    assert loc.address == "aws_iam_role.orders_api"
    assert find_role(files, "billing-role").address == "aws_iam_role.billing"


def test_find_role_ignores_nested_name_fields():
    tf = '''
resource "aws_iam_role" "x" {
  name_prefix = "orders-"
  inline_policy {
    name = "orders-api-role"
  }
}
'''
    # the only `name = "orders-api-role"` belongs to the inline policy, not the role
    assert find_role({"a.tf": tf}, "orders-api-role") is None


def test_render_fix_is_exact_and_references_role():
    hcl = render_fix(denial(), find_role({"main.tf": MAIN_TF}, "orders-api-role"))
    assert 'role = aws_iam_role.orders_api.name' in hcl
    assert 'Action   = "ssm:GetParameter"' in hcl
    assert 'Resource = "arn:aws:ssm:us-east-1:123456789012:parameter/demo/orders-api/db-url"' in hcl
    assert 'resource "aws_iam_role_policy" "whydenied_ssm_getparameter_abc123"' in hcl


def test_fix_filename_is_unique_per_denial():
    assert fix_filename(denial()) == "whydenied_ssm_getparameter_abc123.tf"


def test_refuses_explicit_deny():
    with pytest.raises(NoSafeFix):
        render_fix(denial(reason="explicit_deny_scp"), None)


def test_refuses_wildcard_action():
    with pytest.raises(NoSafeFix):
        render_fix(denial(action="s3:*"), None)


def test_list_roles_reports_every_issue():
    files = {
        "infra/main.tf": MAIN_TF,
        "infra/other.tf": '''
resource "aws_iam_role" "prefixed" {
  name_prefix = "worker-"
}

resource "aws_iam_role" "from_var" {
  name = var.role_name
}

resource "aws_iam_role" "from_local" {
  name = local.role_name
}

resource "aws_iam_role" "interpolated" {
  name = "orders-${var.env}"
}

resource "aws_iam_role" "unnamed" {
  inline_policy {
    name = "not-the-role-name"
  }
}

resource "aws_iam_role" "commented" {
  name = "costs-role" # owned by finance
}
''',
        "README.md": 'resource "aws_iam_role" "ignored" { name = "x" }',
    }
    roles = {r["address"]: r for r in list_roles(files)}
    assert len(roles) == 8

    assert roles["aws_iam_role.orders_api"] == {
        "address": "aws_iam_role.orders_api", "name": "orders-api-role",
        "path": "infra/main.tf", "ready": True, "issue": None,
    }
    assert roles["aws_iam_role.commented"]["name"] == "costs-role"
    assert roles["aws_iam_role.commented"]["ready"] is True

    assert roles["aws_iam_role.prefixed"]["issue"].startswith("Uses name_prefix.")
    for label in ("from_var", "from_local", "interpolated"):
        assert roles[f"aws_iam_role.{label}"]["issue"].startswith("Name comes from a variable")
    assert roles["aws_iam_role.unnamed"]["issue"].startswith("Has no name")
    for label in ("prefixed", "from_var", "from_local", "interpolated", "unnamed"):
        role = roles[f"aws_iam_role.{label}"]
        assert role["ready"] is False and role["name"] is None and role["path"] == "infra/other.tf"
