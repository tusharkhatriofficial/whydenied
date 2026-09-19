"""Public API for the setup page: POST /try, POST /check, GET /feed.

API Gateway HTTP API (payload format 2.0). See docs/web-api.md for the contract.
Deployed as its own stack (web/template.yaml), never as part of the main stack.
"""

import base64
import dataclasses
import json
import logging
import os
import re
from datetime import datetime, timezone

import boto3

from parse import parse_error_message
from terraform import NoSafeFix, RoleLocation, fix_filename, list_roles, render_fix, role_name_from_arn

log = logging.getLogger()
log.setLevel(logging.INFO)

MAX_BODY_BYTES = 4 * 1024 * 1024   # reject oversized requests before parsing JSON
MAX_ERROR_CHARS = 4000
MAX_FILES = 200
MAX_FILES_BYTES = 1024 * 1024      # 1 MB of file contents in total
FEED_LIMIT = 20

REASON_TEXT = {
    "missing_identity_allow": "No identity-based policy allows this action.",
    "explicit_deny_identity": "An identity-based policy explicitly denies this action.",
    "explicit_deny_scp": "A service control policy explicitly denies this action.",
    "missing_scp_allow": "No service control policy allows this action.",
    "explicit_deny_resource": "A resource-based policy explicitly denies this action.",
    "missing_resource_allow": "No resource-based policy allows this action.",
    "explicit_deny_boundary": "A permissions boundary explicitly denies this action.",
    "missing_boundary_allow": "No permissions boundary allows this action.",
    "explicit_deny_session": "A session policy explicitly denies this action.",
    "missing_session_allow": "No session policy allows this action.",
    "vpc_endpoint_policy": "A VPC endpoint policy blocks this action.",
    "unknown": "AWS did not say which policy caused the denial.",
}

NOT_A_ROLE_NOTE = {
    "user": "The caller is an IAM user, and WhyDenied only fixes IAM roles defined in Terraform.",
    "root": "The caller is the root user, which should not be granted permissions through Terraform.",
    "unknown": "The caller is not an IAM role, so there is no Terraform role to patch.",
}
NOT_ALLOW_NOTE = (
    "Only a missing Allow in an identity-based policy is fixed automatically, "
    "so this denial is left for a human to review."
)
WILDCARD_NOTE = "WhyDenied refuses to grant wildcard actions, so this denial is left for a human to review."

FEED_FIELDS = ("action", "resource", "status", "pr_url", "seen_count", "first_seen", "last_seen")

_table = None


class BadRequest(Exception):
    """Client error; the message is returned to the caller as-is."""


def handler(event, context):
    http = (event.get("requestContext") or {}).get("http") or {}
    method = http.get("method", "")
    path = (event.get("rawPath") or http.get("path") or "").rstrip("/")
    route = ROUTES.get((method, path))
    if route is None:
        return respond(404, {"error": "Not found."})
    try:
        return respond(200, route(event))
    except BadRequest as e:
        return respond(400, {"error": str(e)})
    except Exception:
        log.exception("request failed: %s %s", method, path)
        return respond(500, {"error": "Internal error."})


def try_error(event):
    body = json_body(event)
    text = body.get("error")
    if not isinstance(text, str) or not text.strip():
        raise BadRequest("Send the error message as a string in the \"error\" field.")
    if len(text) > MAX_ERROR_CHARS:
        raise BadRequest(f"The error message is longer than {MAX_ERROR_CHARS} characters.")

    denial = parse_error_message(text)
    if denial is None:
        raise BadRequest("No AccessDenied message was found in the text.")
    # render_fix prints the time the denial was seen; for a paste that is now.
    denial = dataclasses.replace(denial, event_time=iso_now())

    kind = principal_type(denial.principal_arn)
    role_name = role_name_from_arn(denial.principal_arn) if kind == "role" else None
    fix, note = None, None
    if kind != "role":
        note = NOT_A_ROLE_NOTE[kind]
    else:
        address = "aws_iam_role." + re.sub(r"[^A-Za-z0-9]", "_", role_name)
        try:
            hcl = render_fix(denial, RoleLocation(path="main.tf", address=address))
            fix = {"filename": fix_filename(denial), "hcl": hcl}
            note = (f"The role address {address} is inferred from the role name. "
                    "In a real run WhyDenied reads it from your repository.")
        except NoSafeFix:
            note = WILDCARD_NOTE if denial.reason == "missing_identity_allow" else NOT_ALLOW_NOTE

    return {
        "denial": {
            "principal_arn": denial.principal_arn,
            "principal_type": kind,
            "role_name": role_name,
            "action": denial.action,
            "resource": denial.resource,
            "reason": denial.reason,
            "reason_text": REASON_TEXT.get(denial.reason, REASON_TEXT["unknown"]),
        },
        "fixable": fix is not None,
        "fix": fix,
        "note": note,
    }


def check(event):
    files = json_body(event).get("files")
    if not isinstance(files, dict):
        raise BadRequest("Send the Terraform files as an object in the \"files\" field.")
    if len(files) > MAX_FILES:
        raise BadRequest(f"Send at most {MAX_FILES} files.")
    if not all(isinstance(k, str) and isinstance(v, str) for k, v in files.items()):
        raise BadRequest("Each file path and file content must be a string.")
    if sum(len(v.encode()) for v in files.values()) > MAX_FILES_BYTES:
        raise BadRequest("The files are larger than 1 MB in total.")

    roles = list_roles(files)
    return {"roles": roles, "summary": {"total": len(roles), "ready": sum(r["ready"] for r in roles)}}


def feed(event):
    items = [i for i in scan_all() if ":role/" in str(i.get("principal_arn", ""))]
    items.sort(key=lambda i: str(i.get("last_seen") or ""), reverse=True)
    denials = []
    for item in items[:FEED_LIMIT]:
        d = {field: plain(item.get(field)) for field in FEED_FIELDS}
        d["role_name"] = role_name_from_arn(item["principal_arn"])
        d["first_seen"] = utc_z(d["first_seen"])
        d["last_seen"] = utc_z(d["last_seen"])
        denials.append(d)
    return {"denials": denials, "updated_at": iso_now()}


ROUTES = {
    ("POST", "/try"): try_error,
    ("POST", "/check"): check,
    ("GET", "/feed"): feed,
}


def table():
    global _table
    if _table is None:
        _table = boto3.resource("dynamodb").Table(os.environ["DENIALS_TABLE"])
    return _table


def scan_all():
    names = {f"#{f}": f for f in (*FEED_FIELDS, "principal_arn")}
    kwargs = {"ProjectionExpression": ", ".join(names), "ExpressionAttributeNames": names}
    while True:
        page = table().scan(**kwargs)
        yield from page.get("Items", [])
        if "LastEvaluatedKey" not in page:
            return
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def json_body(event):
    raw = event.get("body") or ""
    if len(raw) > MAX_BODY_BYTES:
        raise BadRequest("The request body is too large.")
    try:
        if event.get("isBase64Encoded"):
            raw = base64.b64decode(raw).decode()
        body = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise BadRequest("The request body must be JSON.") from None
    if not isinstance(body, dict):
        raise BadRequest("The request body must be a JSON object.")
    return body


def principal_type(arn):
    if ":role/" in arn:
        return "role"
    if ":user/" in arn:
        return "user"
    if arn.startswith("arn:") and arn.endswith(":root"):
        return "root"
    return "unknown"


def plain(value):
    """DynamoDB returns numbers as Decimal, which json can't serialise."""
    if value is None or isinstance(value, (str, bool)):
        return value
    try:
        return int(value)
    except (TypeError, ValueError):
        return str(value)


def utc_z(value):
    # Stored as datetime.isoformat() (with microseconds and +00:00); the page gets 2026-09-19T15:32:54Z.
    try:
        dt = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return value
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def iso_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def respond(status, body):
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(body),
    }
