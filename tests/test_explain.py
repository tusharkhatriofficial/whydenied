import io
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / "src" / "analyzer"))

import explain  # noqa: E402
from fixer import open_fix_pr  # noqa: E402
from test_fixer import FakeGitHub  # noqa: E402
from test_terraform import denial  # noqa: E402

CONFIG = {"provider": "openai", "openai_key_param": "/whydenied/openai-api-key", "openai_model": "m"}
GOOD = {
    "summary": "orders-api tried to read its database URL from Parameter Store.",
    "looks_expected": True,
    "risk": "low",
    "risk_reason": "Read-only access to one parameter.",
    "reviewer_tip": "Confirm the parameter holds no password.",
}


def fake_openai(monkeypatch, content, sent=None):
    def urlopen(req, timeout):
        if sent is not None:
            sent.append(json.loads(req.data))
        body = {"choices": [{"message": {"content": content}}]}
        return io.BytesIO(json.dumps(body).encode())

    monkeypatch.setattr(explain.urllib.request, "urlopen", lambda req, timeout: _ctx(urlopen(req, timeout)))


def _ctx(buf):
    class C:
        def __enter__(self):
            return buf

        def __exit__(self, *a):
            return False
    return C()


def test_openai_explanation_is_validated(monkeypatch):
    sent = []
    fake_openai(monkeypatch, json.dumps(GOOD), sent)
    out = explain.explain(denial(), "aws_iam_role.orders_api", "resource ...", CONFIG, lambda name: "sk-test")
    assert out["risk"] == "low" and out["looks_expected"] is True
    assert "Parameter Store" in out["summary"]
    # the denial is wrapped as data, not instructions
    assert "<denial>" in sent[0]["messages"][1]["content"]


def test_markup_and_bad_values_are_stripped(monkeypatch):
    bad = dict(GOOD, summary="Click [here](http://evil) <b>@team</b>", risk="catastrophic", looks_expected="yes")
    fake_openai(monkeypatch, json.dumps(bad))
    out = explain.explain(denial(), "a", "", CONFIG, lambda name: "sk-test")
    assert "[" not in out["summary"] and "<" not in out["summary"] and "@" not in out["summary"]
    assert out["risk"] == "unknown"
    assert out["looks_expected"] is False  # only a real boolean true counts


def test_failures_return_none(monkeypatch):
    fake_openai(monkeypatch, "not json")
    assert explain.explain(denial(), "a", "", CONFIG, lambda name: "sk-test") is None
    assert explain.explain(denial(), "a", "", CONFIG, lambda name: None) is None  # no key stored
    assert explain.explain(denial(), "a", "", {"provider": "none"}, lambda name: "k") is None


def test_pr_body_includes_ai_section():
    gh = FakeGitHub()
    open_fix_pr(denial(), gh, explainer=lambda role, src: explain._validate(GOOD))
    body = gh.prs[0]["body"]
    assert "### AI review" in body and "Risk if granted:** low" in body


def test_pr_opens_without_ai():
    gh = FakeGitHub()
    open_fix_pr(denial(), gh, explainer=lambda role, src: None)
    assert "### AI review" not in gh.prs[0]["body"]
