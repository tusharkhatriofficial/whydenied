import base64
import json
import pathlib
import sys
from decimal import Decimal

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / "src" / "analyzer"))

import parse  # noqa: E402
import web  # noqa: E402
from test_parse import ROLE_MESSAGE  # noqa: E402
from test_terraform import MAIN_TF  # noqa: E402


def request(method, path, body=None, raw=None, b64=False):
    event = {"rawPath": path, "requestContext": {"http": {"method": method, "path": path}}}
    if body is not None or raw is not None:
        text = raw if raw is not None else json.dumps(body)
        event["body"] = base64.b64encode(text.encode()).decode() if b64 else text
        event["isBase64Encoded"] = b64
    response = web.handler(event, None)
    return response["statusCode"], json.loads(response["body"])


class FakeTable:
    def __init__(self, pages):
        self.pages = pages
        self.calls = []

    def scan(self, **kwargs):
        self.calls.append(kwargs)
        return self.pages[len(self.calls) - 1]


@pytest.fixture
def table(monkeypatch):
    def install(*pages):
        fake = FakeTable(list(pages))
        monkeypatch.setattr(web, "table", lambda: fake)
        return fake
    return install


def item(n, principal="arn:aws:iam::123456789012:role/orders-api-role", **extra):
    values = {
        "id": f"id{n}",
        "principal_arn": principal,
        "action": "ssm:GetParameter",
        "resource": f"arn:aws:ssm:us-east-1:123456789012:parameter/demo/{n}",
        "status": "pr_open",
        "pr_url": f"https://github.com/me/infra/pull/{n}",
        "seen_count": Decimal(n),
        "first_seen": "2026-09-19T15:32:54.123456+00:00",
        "last_seen": f"2026-09-19T15:{n:02d}:00.000001+00:00",
        "error_message": "not for the page",
    }
    values.update(extra)
    return values


# POST /try

def test_try_role_is_fixable():
    status, body = request("POST", "/try", {"error": "An error occurred (AccessDeniedException) when "
                                                     "calling the GetParameter operation: " + ROLE_MESSAGE})
    assert status == 200
    assert body["denial"] == {
        "principal_arn": "arn:aws:iam::123456789012:role/orders-api-role",
        "principal_type": "role",
        "role_name": "orders-api-role",
        "action": "ssm:GetParameter",
        "resource": "arn:aws:ssm:us-east-1:123456789012:parameter/app/db",
        "reason": "missing_identity_allow",
        "reason_text": "No identity-based policy allows this action.",
    }
    assert body["fixable"] is True
    assert body["fix"]["filename"].startswith("whydenied_ssm_getparameter_")
    assert "role = aws_iam_role.orders_api_role.name" in body["fix"]["hcl"]
    assert 'Action   = "ssm:GetParameter"' in body["fix"]["hcl"]
    assert "aws_iam_role.orders_api_role is inferred" in body["note"]


def test_try_accepts_base64_body():
    status, body = request("POST", "/try", {"error": ROLE_MESSAGE}, b64=True)
    assert status == 200 and body["fixable"] is True


@pytest.mark.parametrize("message, kind", [
    ("User: arn:aws:iam::123456789012:user/alice is not authorized to perform: s3:ListBucket "
     "on resource: arn:aws:s3:::b because no identity-based policy allows the s3:ListBucket action", "user"),
    ("User: arn:aws:iam::123456789012:root is not authorized to perform: s3:ListBucket "
     "on resource: arn:aws:s3:::b because no resource-based policy allows the s3:ListBucket action", "root"),
])
def test_try_user_and_root_are_not_fixable(message, kind):
    status, body = request("POST", "/try", {"error": message})
    assert status == 200
    assert body["denial"]["principal_type"] == kind
    assert body["denial"]["role_name"] is None
    assert body["fixable"] is False and body["fix"] is None and body["note"]


def test_try_explicit_deny_is_not_fixable():
    message = ("User: arn:aws:sts::1:assumed-role/ci/x is not authorized to perform: s3:DeleteBucket "
               "on resource: arn:aws:s3:::prod with an explicit deny in a service control policy")
    status, body = request("POST", "/try", {"error": message})
    assert status == 200
    assert body["denial"]["reason"] == "explicit_deny_scp"
    assert body["denial"]["reason_text"] == "A service control policy explicitly denies this action."
    assert body["fixable"] is False and body["fix"] is None
    assert "human" in body["note"]


def test_try_wildcard_is_not_fixable():
    status, body = request("POST", "/try", {"error": ROLE_MESSAGE.replace("ssm:GetParameter", "ssm:*")})
    assert status == 200
    assert body["fixable"] is False and "wildcard" in body["note"]


@pytest.mark.parametrize("payload", [
    {"error": "nothing to see here"},
    {"error": ""},
    {"error": 42},
    {},
    {"error": ROLE_MESSAGE + " " * 4000},
])
def test_try_bad_input(payload):
    status, body = request("POST", "/try", payload)
    assert status == 400 and isinstance(body["error"], str)


def test_try_invalid_json():
    assert request("POST", "/try", raw="{not json")[0] == 400
    assert request("POST", "/try", raw='["a list"]')[0] == 400
    assert request("POST", "/try")[0] == 400


def test_every_reason_has_text():
    codes = [code for _, code in parse._REASONS] + ["unknown"]
    assert set(codes) <= set(web.REASON_TEXT)


# POST /check

def test_check_lists_roles():
    files = {"infra/main.tf": MAIN_TF, "infra/w.tf": 'resource "aws_iam_role" "w" {\n  name_prefix = "w-"\n}\n'}
    status, body = request("POST", "/check", {"files": files})
    assert status == 200
    assert body["summary"] == {"total": 3, "ready": 2}
    assert {r["address"] for r in body["roles"]} == {
        "aws_iam_role.orders_api", "aws_iam_role.billing", "aws_iam_role.w"}


def test_check_empty_repo():
    assert request("POST", "/check", {"files": {}}) == (200, {"roles": [], "summary": {"total": 0, "ready": 0}})


@pytest.mark.parametrize("files", [
    None,
    ["main.tf"],
    {"main.tf": 1},
    {f"f{i}.tf": "" for i in range(201)},
    {"big.tf": "x" * (1024 * 1024 + 1)},
])
def test_check_bad_input(files):
    status, body = request("POST", "/check", {"files": files})
    assert status == 400 and isinstance(body["error"], str)


# GET /feed

def test_feed_newest_first_contract_fields_only(table):
    fake = table(
        {"Items": [item(1), item(3, principal="arn:aws:iam::123456789012:user/alice")],
         "LastEvaluatedKey": {"id": "id3"}},
        {"Items": [item(2, pr_url=None), item(4, principal="arn:aws:iam::123456789012:root")]},
    )
    status, body = request("GET", "/feed")
    assert status == 200
    assert fake.calls[1]["ExclusiveStartKey"] == {"id": "id3"}
    assert [d["resource"].rsplit("/", 1)[-1] for d in body["denials"]] == ["2", "1"]
    first = body["denials"][0]
    assert set(first) == {"action", "role_name", "resource", "status", "pr_url",
                          "seen_count", "first_seen", "last_seen"}
    assert first["role_name"] == "orders-api-role"
    assert first["seen_count"] == 2 and type(first["seen_count"]) is int
    assert first["pr_url"] is None
    assert first["first_seen"] == "2026-09-19T15:32:54Z"
    assert first["last_seen"] == "2026-09-19T15:02:00Z"
    assert body["updated_at"].endswith("Z")


def test_feed_limits_to_twenty(table):
    table({"Items": [item(n) for n in range(30)]})
    denials = request("GET", "/feed")[1]["denials"]
    assert len(denials) == 20
    assert denials[0]["last_seen"] == "2026-09-19T15:29:00Z"


def test_feed_error_hides_details(monkeypatch):
    def boom():
        raise RuntimeError("secret internals")
    monkeypatch.setattr(web, "table", boom)
    status, body = request("GET", "/feed")
    assert status == 500 and body == {"error": "Internal error."}


# routing

@pytest.mark.parametrize("method, path", [("GET", "/try"), ("POST", "/feed"), ("GET", "/nope")])
def test_unknown_route(method, path):
    assert request(method, path)[0] == 404


def test_trailing_slash(table):
    table({"Items": []})
    assert request("GET", "/feed/")[0] == 200
