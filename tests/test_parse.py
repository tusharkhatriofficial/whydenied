import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / "src" / "analyzer"))

from parse import fingerprint, parse_denial, parse_error_message  # noqa: E402

EVENTS = pathlib.Path(__file__).parent / "events"


def load(name):
    return json.loads((EVENTS / f"{name}.json").read_text())


def test_sqs_write_denial():
    d = parse_denial(load("sqs_create_queue_denied"))
    # the role, not the temporary sts session
    assert d.principal_arn == "arn:aws:iam::123456789012:role/whydenied-test-denied"
    # SQS writes "sqs:createqueue"; we restore the real casing
    assert d.action == "sqs:CreateQueue"
    assert d.resource == "arn:aws:sqs:us-east-1:123456789012:wd-test"
    assert d.reason == "missing_identity_allow"
    assert d.read_only is False


def test_dynamodb_read_only_denial():
    d = parse_denial(load("dynamodb_list_tables_denied"))
    assert d.action == "dynamodb:ListTables"
    assert d.resource == "arn:aws:dynamodb:us-east-1:123456789012:table/*"
    assert d.reason == "missing_identity_allow"
    assert d.read_only is True


def test_repeats_share_an_id():
    a = parse_denial(load("sqs_create_queue_denied"))
    b = parse_denial(load("sqs_create_queue_denied"))
    assert a.id == b.id
    assert a.id == fingerprint(a.principal_arn, "SQS:CREATEQUEUE", a.resource)


def test_skips_aws_service_callers():
    event = load("sqs_create_queue_denied")
    event["detail"]["userIdentity"] = {"type": "AWSService", "invokedBy": "resource-explorer-2.amazonaws.com"}
    assert parse_denial(event) is None


def test_skips_service_linked_roles():
    event = load("sqs_create_queue_denied")
    event["detail"]["userIdentity"]["sessionContext"]["sessionIssuer"]["arn"] = (
        "arn:aws:iam::123456789012:role/aws-service-role/ops.example.amazonaws.com/AWSServiceRoleForX"
    )
    assert parse_denial(event) is None


def test_iam_user_and_lambda_version_suffix():
    event = load("dynamodb_list_tables_denied")
    detail = event["detail"]
    detail["userIdentity"] = {"type": "IAMUser", "arn": "arn:aws:iam::123456789012:user/alice"}
    detail["eventSource"] = "lambda.amazonaws.com"
    detail["eventName"] = "ListFunctions20150331"
    detail["errorMessage"] = (
        "User: arn:aws:iam::123456789012:user/alice is not authorized to perform: "
        "lambda:ListFunctions on resource: * because no identity-based policy allows "
        "the lambda:ListFunctions action"
    )
    d = parse_denial(event)
    assert d.principal_arn == "arn:aws:iam::123456789012:user/alice"
    assert d.action == "lambda:ListFunctions"
    assert d.resource == "*"


def test_explicit_deny_reason():
    event = load("sqs_create_queue_denied")
    event["detail"]["errorMessage"] = (
        "User: x is not authorized to perform: sqs:CreateQueue on resource: y "
        "with an explicit deny in a service control policy"
    )
    assert parse_denial(event).reason == "explicit_deny_scp"


ROLE_MESSAGE = (
    "User: arn:aws:sts::123456789012:assumed-role/orders-api-role/orders-api "
    "is not authorized to perform: ssm:GetParameter on resource: "
    "arn:aws:ssm:us-east-1:123456789012:parameter/app/db "
    "because no identity-based policy allows the ssm:GetParameter action"
)


def test_error_message_from_assumed_role():
    d = parse_error_message(ROLE_MESSAGE)
    # the role, not the temporary sts session
    assert d.principal_arn == "arn:aws:iam::123456789012:role/orders-api-role"
    assert d.action == "ssm:GetParameter"
    assert d.resource == "arn:aws:ssm:us-east-1:123456789012:parameter/app/db"
    assert d.reason == "missing_identity_allow"
    assert d.id == fingerprint(d.principal_arn, d.action, d.resource)


def test_error_message_embedded_in_botocore_text():
    text = (
        "Traceback (most recent call last):\n  ...\n"
        "botocore.exceptions.ClientError: An error occurred (AccessDeniedException) "
        "when calling the GetParameter operation: " + ROLE_MESSAGE.replace("on resource:", "on\nresource:") + "\n"
    )
    d = parse_error_message(text)
    assert d.principal_arn == "arn:aws:iam::123456789012:role/orders-api-role"
    assert d.resource == "arn:aws:ssm:us-east-1:123456789012:parameter/app/db"
    assert d.error_code == "AccessDeniedException"
    assert d.id == parse_error_message(ROLE_MESSAGE).id


def test_error_message_from_iam_user_without_resource():
    d = parse_error_message(
        "User: arn:aws:iam::123456789012:user/alice is not authorized to perform: iam:ListRoles."
    )
    assert d.principal_arn == "arn:aws:iam::123456789012:user/alice"
    assert d.action == "iam:ListRoles"
    assert d.resource == "*"
    assert d.reason == "unknown"


def test_error_message_from_root():
    d = parse_error_message(
        "User: arn:aws:iam::123456789012:root is not authorized to perform: s3:GetObject "
        "on resource: arn:aws:s3:::bucket/key because no resource-based policy allows the s3:GetObject action"
    )
    assert d.principal_arn == "arn:aws:iam::123456789012:root"
    assert d.reason == "missing_resource_allow"


def test_error_message_with_explicit_deny():
    d = parse_error_message(
        "User: arn:aws:sts::123456789012:assumed-role/ci/run-42 is not authorized to perform: "
        "s3:DeleteBucket on resource: arn:aws:s3:::prod-data with an explicit deny in a service control policy"
    )
    assert d.principal_arn == "arn:aws:iam::123456789012:role/ci"
    assert d.resource == "arn:aws:s3:::prod-data"
    assert d.reason == "explicit_deny_scp"


def test_error_message_garbage_is_none():
    assert parse_error_message("") is None
    assert parse_error_message("An error occurred (AccessDenied) when calling the ListBuckets operation: Access Denied") is None
    assert parse_error_message("hello world") is None
