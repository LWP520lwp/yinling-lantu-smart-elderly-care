"""FastAPI 接口冒烟测试：健康检查、登录限流、SSE 对话、鉴权与 WebSocket。

使用 ``with TestClient(app)`` 显式触发 lifespan，确保建表与资源生命周期正常执行。
所有数据库读写经 conftest 的 isolated_storage 夹具隔离到临时 SQLite。
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.main import app


@pytest.fixture
def client(isolated_storage) -> TestClient:
    with TestClient(app) as test_client:
        yield test_client


def _auth_header(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _login(client: TestClient, account: str, password: str = "123456"):
    return client.post(
        "/api/auth/login", json={"account": account, "password": password}
    )


def _parse_sse(text: str) -> list[dict]:
    """从 SSE 文本中解析所有 data 帧。"""
    frames = []
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            frames.append(json.loads(line[5:].strip()))
    return frames


# --------------------------------------------------------------------------- 健康检查
def test_health(client: TestClient) -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert isinstance(body["llm_enabled"], bool)


# --------------------------------------------------------------------------- 登录
def test_login_success(client: TestClient) -> None:
    body = _login(client, "admin").json()
    assert body["token"]
    assert body["user"]["account"] == "admin"
    assert body["user"]["role"] == "admin"
    assert isinstance(body["expires_at"], int)


def test_login_wrong_password_returns_401(client: TestClient) -> None:
    response = _login(client, "admin", "wrong-password")
    assert response.status_code == 401
    assert response.json()["code"] == "INVALID_CREDENTIALS"


def test_login_rate_limit_returns_429(client: TestClient) -> None:
    # 用不存在的账号做限流，避免污染真实演示账号
    for _ in range(5):
        client.post("/api/auth/login", json={"account": "ghost", "password": "x"})
    response = client.post(
        "/api/auth/login", json={"account": "ghost", "password": "x"}
    )
    assert response.status_code == 429
    assert response.json()["code"] == "TOO_MANY_ATTEMPTS"


# --------------------------------------------------------------------------- 当前用户
def test_me_requires_auth(client: TestClient) -> None:
    assert client.get("/api/auth/me").status_code == 401
    token = _login(client, "admin").json()["token"]
    response = client.get("/api/auth/me", headers=_auth_header(token))
    assert response.status_code == 200
    assert response.json()["user"]["account"] == "admin"


# --------------------------------------------------------------------------- SSE 对话
def test_chat_sse_stream(client: TestClient) -> None:
    token = _login(client, "admin").json()["token"]
    response = client.post(
        "/api/chat",
        headers=_auth_header(token),
        json={"messages": [{"role": "user", "content": "血压高怎么办"}]},
    )
    assert response.status_code == 200
    assert "text/event-stream" in response.headers["content-type"]

    frames = _parse_sse(response.text)
    assert any(frame.get("type") == "done" for frame in frames)
    content = "".join(frame.get("content", "") for frame in frames if frame.get("type") == "token")
    assert content  # 有实际正文输出


def test_chat_requires_auth(client: TestClient) -> None:
    response = client.post(
        "/api/chat", json={"messages": [{"role": "user", "content": "hi"}]}
    )
    assert response.status_code == 401


# --------------------------------------------------------------------------- 审计权限
def test_audit_logs_role_permissions(client: TestClient) -> None:
    admin_token = _login(client, "admin").json()["token"]
    assert client.get("/api/audit/logs", headers=_auth_header(admin_token)).status_code == 200

    worker_token = _login(client, "shegong01").json()["token"]
    forbidden = client.get("/api/audit/logs", headers=_auth_header(worker_token))
    assert forbidden.status_code == 403
    assert forbidden.json()["code"] == "FORBIDDEN"

    assert client.get("/api/audit/logs").status_code == 401


# --------------------------------------------------------------------------- 命令下发
def test_device_command_admin_disabled_by_default(client: TestClient) -> None:
    """未配置云凭据时 admin 调用返回 503。"""
    token = _login(client, "admin").json()["token"]
    response = client.post(
        "/api/device/command",
        headers=_auth_header(token),
        json={"device_id": "D1", "command_name": "restart"},
    )
    assert response.status_code == 503
    assert response.json()["code"] == "CLOUD_COMMAND_DISABLED"


def test_device_command_non_admin_forbidden(client: TestClient) -> None:
    token = _login(client, "shegong01").json()["token"]
    response = client.post(
        "/api/device/command",
        headers=_auth_header(token),
        json={"device_id": "D1"},
    )
    assert response.status_code == 403


# --------------------------------------------------------------------------- WebSocket
def test_websocket_hello(client: TestClient) -> None:
    token = _login(client, "admin").json()["token"]
    with client.websocket_connect(f"/ws?token={token}") as websocket:
        message = websocket.receive_json()
        assert message["type"] == "hello"
        assert "iot_enabled" in message["data"]


def test_websocket_rejects_missing_token(client: TestClient) -> None:
    with pytest.raises(WebSocketDisconnect) as exc_info:
        with client.websocket_connect("/ws") as websocket:
            websocket.receive_json()
    assert exc_info.value.code == 1008
