"""Turn a CloudTrail "AWS API Call via CloudTrail" event into a Denial.

Everything in this module is pure (no AWS calls), so it can be unit-tested
against real events saved in tests/events/.
"""

import hashlib
import re
from dataclasses import dataclass, asdict

# errorMessage looks like:
#   "User: <arn> is not authorized to perform: <action> on resource: <arn>
#    because no identity-based policy allows the <action> action"
_MESSAGE_RE = re.compile(
    r"not authorized to perform: (?P<action>\S+)"
    r"(?: on resource: (?P<resource>\S+))?"
    r"(?: because (?P<reason>.+))?"
)

# The phrase AWS uses in errorMessage -> our short reason code.
# Order matters: the first phrase found wins.
_REASONS = [
    ("no identity-based policy allows", "missing_identity_allow"),
    ("explicit deny in an identity-based policy", "explicit_deny_identity"),
    ("explicit deny in a service control policy", "explicit_deny_scp"),
    ("no service control policy allows", "missing_scp_allow"),
    ("explicit deny in a resource-based policy", "explicit_deny_resource"),
    ("no resource-based policy allows", "missing_resource_allow"),
    ("explicit deny in a permissions boundary", "explicit_deny_boundary"),
    ("no permissions boundary allows", "missing_boundary_allow"),
    ("explicit deny in a session policy", "explicit_deny_session"),
    ("no session policy allows", "missing_session_allow"),
    ("VPC endpoint policy", "vpc_endpoint_policy"),
]

# eventSource prefixes that differ from the IAM action prefix.
_SERVICE_PREFIX = {
    "monitoring": "cloudwatch",
    "email": "ses",
}

# Lambda event names carry an API version suffix, e.g. "ListFunctions20150331".
_VERSION_SUFFIX_RE = re.compile(r"\d{8}(v\d+)?$")


@dataclass
class Denial:
    id: str               # stable fingerprint of (principal, action, resource)
    principal_arn: str    # the IAM role or user to fix, not the temporary session
    action: str           # e.g. "dynamodb:ListTables"
    resource: str         # e.g. "arn:aws:sqs:us-east-1:123456789012:wd-test"
    reason: str           # short code from _REASONS, or "unknown"
    error_code: str
    error_message: str
    read_only: bool
    region: str
    event_time: str
    event_id: str

    def to_dict(self):
        return asdict(self)


def parse_denial(event):
    """Return a Denial, or None if the event isn't something we should act on."""
    detail = event.get("detail") or {}
    identity = detail.get("userIdentity") or {}

    # AWS services acting on their own behalf aren't ours to fix.
    if identity.get("type") == "AWSService":
        return None

    principal = _principal_arn(identity)
    if not principal or ":role/aws-service-role/" in principal:
        return None  # service-linked roles are managed by AWS

    message = detail.get("errorMessage") or ""
    match = _MESSAGE_RE.search(message)

    action = _action(detail, match)
    resource = (match and match.group("resource")) or _first_resource(detail) or "*"

    return Denial(
        id=fingerprint(principal, action, resource),
        principal_arn=principal,
        action=action,
        resource=resource,
        reason=_reason(message),
        error_code=detail.get("errorCode", ""),
        error_message=message,
        read_only=bool(detail.get("readOnly")),
        region=detail.get("awsRegion") or event.get("region", ""),
        event_time=detail.get("eventTime", ""),
        event_id=detail.get("eventID", ""),
    )


def fingerprint(principal, action, resource):
    """Same principal + action + resource -> same id, so repeats are counted, not duplicated."""
    raw = f"{principal}|{action.lower()}|{resource}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _principal_arn(identity):
    # For an assumed role, userIdentity.arn is the temporary session
    # (arn:aws:sts::…:assumed-role/<role>/<session>). The thing to fix is the role.
    if identity.get("type") == "AssumedRole":
        issuer = (identity.get("sessionContext") or {}).get("sessionIssuer") or {}
        return issuer.get("arn")
    return identity.get("arn")


def _action(detail, match):
    derived = _derived_action(detail)
    from_message = match.group("action") if match else None

    # Some services write the action in lower case ("sqs:createqueue").
    # If it's the same action, prefer our correctly-cased version.
    if from_message and derived and from_message.lower() == derived.lower():
        return derived
    return from_message or derived or "unknown:unknown"


def _derived_action(detail):
    source = detail.get("eventSource", "")
    name = detail.get("eventName", "")
    if not source or not name:
        return None
    service = source.split(".")[0]
    service = _SERVICE_PREFIX.get(service, service)
    return f"{service}:{_VERSION_SUFFIX_RE.sub('', name)}"


def _first_resource(detail):
    for r in detail.get("resources") or []:
        if r.get("ARN"):
            return r["ARN"]
    return None


def _reason(message):
    for phrase, code in _REASONS:
        if phrase in message:
            return code
    return "unknown"


# A pasted error, e.g. from botocore:
#   "An error occurred (AccessDeniedException) when calling the GetParameter
#    operation: User: <arn> is not authorized to perform: <action> ..."
_PASTED_RE = re.compile(
    r"User: (?P<principal>\S+) is not authorized to perform: (?P<action>\S+?)[.,;]?"
    r"(?= |$)(?: on resource: (?P<resource>\S+?)[.,;]?(?= |$))?"
)
_ERROR_CODE_RE = re.compile(r"\((?P<code>[A-Za-z.]*(?:AccessDenied|Unauthorized)[A-Za-z.]*)\)")
# arn:aws:sts::<account>:assumed-role/<role>/<session>
_SESSION_RE = re.compile(r"^arn:(?P<partition>[\w-]+):sts::(?P<account>\d+):assumed-role/(?P<role>[^/]+)/")


def parse_error_message(text):
    """Find an AccessDenied message anywhere in text and return a Denial, or None.

    Only the message is available, so region, event time and event id are empty.
    """
    text = " ".join((text or "").split())  # undo line wrapping from terminals
    match = _PASTED_RE.search(text)
    if not match:
        return None

    principal = _role_from_session(match.group("principal"))
    action = match.group("action")
    resource = match.group("resource") or "*"
    # The reason belongs to this message, not to anything pasted after it.
    message = text[match.start():]
    end = message.find(" User: ")
    if end > 0:
        message = message[:end]
    code = _ERROR_CODE_RE.search(text[:match.start()])

    return Denial(
        id=fingerprint(principal, action, resource),
        principal_arn=principal,
        action=action,
        resource=resource,
        reason=_reason(message),
        error_code=code.group("code") if code else "AccessDenied",
        error_message=message,
        read_only=False,
        region="",
        event_time="",
        event_id="",
    )


def _role_from_session(arn):
    # The session ARN hides the role path; the role name is what matching needs.
    m = _SESSION_RE.match(arn)
    if not m:
        return arn
    return f"arn:{m.group('partition')}:iam::{m.group('account')}:role/{m.group('role')}"
