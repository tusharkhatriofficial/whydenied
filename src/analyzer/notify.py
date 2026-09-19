"""Send a denial alert to Slack and/or Discord incoming webhooks."""

import json
import urllib.request

_STATUS_TEXT = {
    "pr_open": "Fix PR opened",
    "needs_human": "Needs a human: can't be fixed automatically",
    "role_not_found": "Role not found in the Terraform repo",
    "not_a_role": "Recorded: caller is not an IAM role",
    "error": "WhyDenied hit an error opening the fix",
}


def summary(denial, status, pr_url=None, note=None):
    """The facts every alert shows, independent of chat platform."""
    return {
        "title": f"AccessDenied: {denial.action}",
        "role": denial.principal_arn.split(":role/", 1)[-1],
        "resource": denial.resource,
        "status": _STATUS_TEXT.get(status, status),
        "pr_url": pr_url,
        "note": note,
    }


def slack_payload(s):
    fields = [
        {"type": "mrkdwn", "text": f"*Role*\n`{s['role']}`"},
        {"type": "mrkdwn", "text": f"*Status*\n{s['status']}"},
    ]
    blocks = [
        {"type": "header", "text": {"type": "plain_text", "text": s["title"]}},
        {"type": "section", "fields": fields},
        {"type": "section", "text": {"type": "mrkdwn", "text": f"*Resource*\n`{s['resource']}`"}},
    ]
    if s["pr_url"]:
        blocks.append({"type": "actions", "elements": [
            {"type": "button", "text": {"type": "plain_text", "text": "Review fix PR"}, "url": s["pr_url"]},
        ]})
    if s["note"]:
        blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text": s["note"]}]})
    return {"text": f"{s['title']} ({s['role']})", "blocks": blocks}


def discord_payload(s):
    embed = {
        "title": s["title"],
        "color": 0x2EA043 if s["pr_url"] else 0xD29922,
        "fields": [
            {"name": "Role", "value": f"`{s['role']}`", "inline": True},
            {"name": "Status", "value": s["status"], "inline": True},
            {"name": "Resource", "value": f"`{s['resource']}`"},
        ],
    }
    if s["pr_url"]:
        embed["url"] = s["pr_url"]
        embed["fields"].append({"name": "Fix", "value": f"[Review the PR]({s['pr_url']})"})
    if s["note"]:
        embed["footer"] = {"text": s["note"][:2000]}
    return {"username": "WhyDenied", "embeds": [embed]}


def send(url, payload):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "whydenied"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5):
        pass
