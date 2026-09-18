import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / "src" / "analyzer"))

from parse import parse_denial, fingerprint  # noqa: E402

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
