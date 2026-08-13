import asyncio
import json
import sys
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

PYTHON_ROOT = Path(__file__).resolve().parents[1]
if str(PYTHON_ROOT) not in sys.path:
    sys.path.insert(0, str(PYTHON_ROOT))

try:
    import requests  # noqa: F401
except ModuleNotFoundError:
    requests_stub = types.ModuleType("requests")
    requests_stub.request = lambda *args, **kwargs: None
    requests_stub.post = lambda *args, **kwargs: None
    requests_stub.get = lambda *args, **kwargs: None
    sys.modules["requests"] = requests_stub

from ready_sidecar.channels.feishu_plugin_ops import FeishuPluginOperations


class FakeResponse:
    def __init__(self, status_code, payload=None, json_error=None):
        self.status_code = status_code
        self._payload = payload
        self._json_error = json_error

    def json(self):
        if self._json_error:
            raise self._json_error
        return self._payload


class FeishuPluginOperationsFailureContractTest(unittest.TestCase):
    FAILURE_KEYS = {
        "success",
        "ok",
        "errorKind",
        "error",
        "status_code",
        "feishu_code",
    }

    def setUp(self):
        self.operations = FeishuPluginOperations("app-id", "app-secret")
        self.operations._access_token = "sensitive-token"
        self.operations._access_token_exp_at = time.time() + 3600

    def read_with(self, response=None, error=None):
        with patch(
            "ready_sidecar.channels.feishu_plugin_ops.requests.request",
            side_effect=error,
            return_value=response,
        ):
            return asyncio.run(self.operations.read_document("doc-token", "docx"))

    def assert_safe_failure(self, result, *credential_values):
        self.assertFalse(result["success"])
        self.assertFalse(result["ok"])
        self.assertLessEqual(set(result), self.FAILURE_KEYS)
        serialized = json.dumps(result, ensure_ascii=False, sort_keys=True)
        for value in credential_values:
            self.assertNotIn(value, serialized)

    def test_http_failures_keep_status_and_exact_kind(self):
        cases = [
            (401, "feishu_auth_required"),
            (403, "feishu_permission_denied"),
            (404, "feishu_not_found"),
            (429, "feishu_rate_limited"),
            (500, "feishu_upstream_unavailable"),
        ]
        for status, error_kind in cases:
            with self.subTest(status=status):
                result = self.read_with(FakeResponse(status, {"code": 0, "msg": "failure"}))
                self.assertFalse(result["success"])
                self.assertFalse(result["ok"])
                self.assertEqual(result["errorKind"], error_kind)
                self.assertEqual(result["status_code"], status)
                self.assertEqual(result["feishu_code"], 0)

    def test_feishu_code_and_message_are_preserved_without_token_leak(self):
        result = self.read_with(FakeResponse(
            200,
            {"code": 403, "msg": "permission denied sensitive-token"},
        ))
        self.assertEqual(result["errorKind"], "feishu_permission_denied")
        self.assertEqual(result["feishu_code"], 403)
        self.assertNotIn("sensitive-token", str(result))

    def test_timeout_is_network_failure(self):
        result = self.read_with(error=TimeoutError("request timed out"))
        self.assertEqual(result["errorKind"], "feishu_network_error")

    def test_malformed_response_is_upstream_failure(self):
        result = self.read_with(FakeResponse(200, json_error=ValueError("bad json")))
        self.assertEqual(result["errorKind"], "feishu_upstream_unavailable")

    def test_exception_message_redacts_every_credential_form(self):
        result = self.read_with(error=RuntimeError(
            "app_id=app-id app_secret='app-secret' "
            "access_token=untracked-access tenant_access_token=untracked-tenant "
            "Bearer bearer-secret sensitive-token"
        ))
        self.assert_safe_failure(
            result,
            "app-id",
            "app-secret",
            "untracked-access",
            "untracked-tenant",
            "bearer-secret",
            "sensitive-token",
        )

    def test_failure_dict_is_rebuilt_from_whitelisted_fields(self):
        result = self.operations._failure({
            "success": False,
            "ok": False,
            "errorKind": "feishu_permission_denied",
            "error": {
                "app_id": "app-id",
                "app_secret": "app-secret",
                "access_token": "sensitive-token",
                "tenant_access_token": "nested-tenant-token",
            },
            "statusCode": "403",
            "feishuCode": "403",
            "app_secret": "top-level-secret",
            "nested": {"access_token": "nested-access-token"},
        })
        self.assert_safe_failure(
            result,
            "app-id",
            "app-secret",
            "sensitive-token",
            "nested-tenant-token",
            "top-level-secret",
            "nested-access-token",
        )
        self.assertEqual(result["errorKind"], "feishu_permission_denied")
        self.assertEqual(result["status_code"], 403)
        self.assertEqual(result["feishu_code"], 403)

    def test_token_refresh_error_cannot_echo_request_or_response_credentials(self):
        operations = FeishuPluginOperations("refresh-app-id", "refresh-app-secret")
        response = FakeResponse(401, {
            "code": 401,
            "msg": (
                "app_id=refresh-app-id app_secret=refresh-app-secret "
                "tenant_access_token=response-tenant-token"
            ),
        })
        with patch(
            "ready_sidecar.channels.feishu_plugin_ops.requests.post",
            return_value=response,
        ):
            result = asyncio.run(operations.read_document("doc-token", "docx"))

        self.assert_safe_failure(
            result,
            "refresh-app-id",
            "refresh-app-secret",
            "response-tenant-token",
        )
        self.assertEqual(result["errorKind"], "feishu_auth_required")

    def test_public_validation_failures_use_the_same_safe_whitelist(self):
        result = asyncio.run(self.operations.read_document(
            "doc-token",
            "app_secret=app-secret tenant_access_token=validation-token",
        ))
        self.assert_safe_failure(result, "app-secret", "validation-token")
        self.assertEqual(result["errorKind"], "feishu_invalid_request")


if __name__ == "__main__":
    unittest.main()
