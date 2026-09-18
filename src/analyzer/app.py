"""Analyzer Lambda: EventBridge (CloudTrail AccessDenied) -> DynamoDB."""

import json
import logging
import os
from datetime import datetime, timezone

import boto3

from parse import parse_denial

log = logging.getLogger()
log.setLevel(logging.INFO)

table = boto3.resource("dynamodb").Table(os.environ["DENIALS_TABLE"])


def handler(event, context):
    denial = parse_denial(event)
    if denial is None:
        log.info("skipped event %s", event.get("id"))
        return {"skipped": True}

    now = datetime.now(timezone.utc).isoformat()
    d = denial.to_dict()

    # One item per (principal, action, resource). The first sighting creates it;
    # every repeat bumps the count and lastSeen instead of adding a new item.
    result = table.update_item(
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
    )

    item = result["Attributes"]
    log.info(json.dumps({
        "denial_id": denial.id,
        "action": denial.action,
        "principal": denial.principal_arn,
        "reason": denial.reason,
        "seen_count": int(item["seen_count"]),
    }))
    return {"id": denial.id, "seen_count": int(item["seen_count"])}
