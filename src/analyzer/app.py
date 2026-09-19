"""Analyzer Lambda: EventBridge (CloudTrail AccessDenied) -> DynamoDB -> fix PR -> alerts."""

import json
import logging
import os
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError

import notify
from fixer import NoSafeFix, RoleNotFound, open_fix_pr
from github import GitHub
from parse import parse_denial

log = logging.getLogger()
log.setLevel(logging.INFO)

table = boto3.resource("dynamodb").Table(os.environ["DENIALS_TABLE"])
ssm = boto3.client("ssm")

GITHUB_REPO = os.environ.get("GITHUB_REPO", "")
GITHUB_TOKEN_PARAM = os.environ.get("GITHUB_TOKEN_PARAM", "")
SLACK_WEBHOOK_PARAM = os.environ.get("SLACK_WEBHOOK_PARAM", "")
DISCORD_WEBHOOK_PARAM = os.environ.get("DISCORD_WEBHOOK_PARAM", "")

_secrets = {}


def handler(event, context):
    denial = parse_denial(event)
    if denial is None:
        log.info("skipped event %s", event.get("id"))
        return {"skipped": True}

    item = record(denial)
    seen = int(item["seen_count"])
    log.info(json.dumps({"denial_id": denial.id, "action": denial.action,
                         "principal": denial.principal_arn, "reason": denial.reason, "seen_count": seen}))

    # Only the first sighting gets a PR and an alert; repeats just count.
    if seen > 1 or not claim(denial.id):
        return {"id": denial.id, "seen_count": seen}

    status, pr_url, note = fix(denial)
    finish(denial.id, status, pr_url, note)
    alert(denial, status, pr_url, note)
    return {"id": denial.id, "seen_count": seen, "status": status, "pr_url": pr_url}


def record(denial):
    """One item per (principal, action, resource). Repeats bump seen_count and last_seen."""
    now = datetime.now(timezone.utc).isoformat()
    d = denial.to_dict()
    return table.update_item(
        Key={"id": denial.id},
        UpdateExpression=(
            "SET principal_arn = :p, #action = :a, #resource = :r, reason = :why, "
            "error_code = :code, error_message = :msg, read_only = :ro, #region = :reg, "
            "last_seen = :now, last_event_id = :eid, "
            "first_seen = if_not_exists(first_seen, :now), "
            "#status = if_not_exists(#status, :new) "
            "ADD seen_count :one"
        ),
        ExpressionAttributeNames={
            # these are DynamoDB reserved words
            "#action": "action",
            "#resource": "resource",
            "#region": "region",
            "#status": "status",
        },
        ExpressionAttributeValues={
            ":p": d["principal_arn"],
            ":a": d["action"],
            ":r": d["resource"],
            ":why": d["reason"],
            ":code": d["error_code"],
            ":msg": d["error_message"],
            ":ro": d["read_only"],
            ":reg": d["region"],
            ":now": now,
            ":eid": d["event_id"],
            ":new": "new",
            ":one": 1,
        },
        ReturnValues="ALL_NEW",
    )["Attributes"]


def claim(denial_id):
    """Move status new -> fixing. Only one invocation wins, so we never open two PRs."""
    try:
        table.update_item(
            Key={"id": denial_id},
            UpdateExpression="SET #status = :fixing",
            ConditionExpression="#status = :new",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={":fixing": "fixing", ":new": "new"},
        )
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise


def fix(denial):
    """Returns (status, pr_url, note)."""
    token = secret(GITHUB_TOKEN_PARAM)
    if not (GITHUB_REPO and token):
        return "needs_human", None, "GitHub isn't configured, so no PR was opened."
    try:
        return "pr_open", open_fix_pr(denial, GitHub(token, GITHUB_REPO)), None
    except NoSafeFix as e:
        return "needs_human", None, str(e)
    except RoleNotFound as e:
        return "role_not_found", None, str(e)
    except Exception as e:  # keep going so the team still gets alerted
        log.exception("opening fix PR failed")
        return "error", None, f"{type(e).__name__}: {e}"[:500]


def finish(denial_id, status, pr_url, note):
    names = {"#status": "status"}
    values = {":s": status}
    sets = ["#status = :s"]
    if pr_url:
        sets.append("pr_url = :u")
        values[":u"] = pr_url
    if note:
        sets.append("note = :n")
        values[":n"] = note
    table.update_item(
        Key={"id": denial_id},
        UpdateExpression="SET " + ", ".join(sets),
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )


def alert(denial, status, pr_url, note):
    s = notify.summary(denial, status, pr_url, note)
    for param, payload in ((SLACK_WEBHOOK_PARAM, notify.slack_payload), (DISCORD_WEBHOOK_PARAM, notify.discord_payload)):
        url = secret(param)
        if not url:
            continue
        try:
            notify.send(url, payload(s))
        except Exception:
            log.exception("alert to %s failed", param)


def secret(name):
    """Read a SecureString from SSM once per container. Missing parameter -> None."""
    if not name:
        return None
    if name not in _secrets:
        try:
            _secrets[name] = ssm.get_parameter(Name=name, WithDecryption=True)["Parameter"]["Value"]
        except ssm.exceptions.ParameterNotFound:
            _secrets[name] = None
    return _secrets[name]
