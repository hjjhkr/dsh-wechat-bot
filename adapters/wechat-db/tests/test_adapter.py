"""The adapter as the plugin sees it: a child process speaking protocol v1 on stdio."""
import json
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fixtures import BOT, GROUP, Account, at_source  # noqa: E402

MAIN = Path(__file__).resolve().parents[1] / "main.py"


class Client:
    def __init__(self, *args):
        self.proc = subprocess.Popen([sys.executable, "-u", str(MAIN), *args], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.next_id = 0
        self.responses = {}
        self.events = queue.Queue()
        self.cond = threading.Condition()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for raw in self.proc.stdout:
            frame = json.loads(raw)
            if "method" in frame:
                self.events.put(frame)
            else:
                with self.cond:
                    self.responses[frame["id"]] = frame
                    self.cond.notify_all()

    def call(self, method, params=None):
        self.next_id += 1
        request_id = self.next_id
        self.proc.stdin.write((json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}}) + "\n").encode())
        self.proc.stdin.flush()
        with self.cond:
            assert self.cond.wait_for(lambda: request_id in self.responses, timeout=10), f"{method} timed out"
            frame = self.responses.pop(request_id)
        if "error" in frame:
            raise RuntimeError(frame["error"]["data"]["code"])
        return frame["result"]

    def next_event(self, method, timeout=5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                frame = self.events.get(timeout=max(0.01, deadline - time.monotonic()))
            except queue.Empty:
                break
            if frame["method"] == method:
                return frame["params"]
        raise AssertionError(f"no {method} within {timeout}s")

    def close(self):
        try:
            self.call("shutdown")
        finally:
            self.proc.wait(timeout=5)


@pytest.fixture
def world(tmp_path):
    account = Account(tmp_path / "db_storage")
    account.add(GROUP, "wxid_alice", "开始监听之前的旧消息")
    client = Client("--plain", str(account.root), "--self", BOT, "--poll-ms", "50", "--outbox", str(tmp_path / "outbox.jsonl"))
    init = client.call("initialize", {"protocolVersion": 1, "dataDir": str(tmp_path), "client": {"name": "test", "version": "0"}})
    yield account, client, init, tmp_path
    client.close()


def test_handshake_account_and_chats(world):
    _, client, init, _ = world
    assert init["protocolVersion"] == 1 and init["adapter"]["name"] == "wechat-db"
    assert init["capabilities"]["history"] is True
    assert client.call("account/status") == {"state": "ready", "self": {"id": BOT, "name": "小鲸鱼"}}
    chats = client.call("chats/list")["chats"]
    assert chats[0]["id"] == GROUP
    assert client.call("chats/list", {"query": "不存在"})["chats"] == []
    assert len(client.call("chats/members", {"chatId": GROUP})["members"]) == 3
    assert [m["text"] for m in client.call("chats/history", {"chatId": GROUP, "limit": 5})["messages"]] == ["开始监听之前的旧消息"]


def test_only_messages_after_watching_are_emitted_in_order(world):
    account, client, _, _ = world
    assert client.call("watch/set", {"chatIds": [GROUP]}) == {"watching": [GROUP]}
    first = account.add(GROUP, "wxid_bob", "新消息一", shard=1)
    second = account.add(GROUP, "wxid_alice", "@小鲸鱼 新消息二", source=at_source(BOT))
    one = client.next_event("event/message")["message"]
    two = client.next_event("event/message")["message"]
    assert (one["id"], one["text"], one["sender"]["id"]) == (first, "新消息一", "wxid_bob")
    assert (two["id"], two["mentions"]) == (second, [BOT])
    with pytest.raises(AssertionError):
        client.next_event("event/message", timeout=0.3)


def test_send_writes_content_json_once_per_client_id(world):
    _, client, _, tmp_path = world
    first = client.call("message/send", {"chatId": GROUP, "clientId": "turn1:0", "content": {"kind": "text", "text": "草"}})
    again = client.call("message/send", {"chatId": GROUP, "clientId": "turn1:0", "content": {"kind": "text", "text": "草"}})
    client.call("message/send", {"chatId": GROUP, "clientId": "turn1:1", "content": {"kind": "sticker", "path": "C:/stickers/dog.gif"}})
    assert first == again == {"messageId": "out:turn1:0"}
    lines = [json.loads(line) for line in (tmp_path / "outbox.jsonl").read_text(encoding="utf-8").splitlines()]
    assert [(e["clientId"], e["chatName"], e["content"]) for e in lines] == [
        ("turn1:0", "测试群", {"kind": "text", "text": "草"}),
        ("turn1:1", "测试群", {"kind": "sticker", "path": "C:/stickers/dog.gif"}),
    ]


def test_errors_are_protocol_errors_not_crashes(world):
    _, client, _, _ = world
    for params, code in [({"chatId": "nope@chatroom", "clientId": "x", "content": {"kind": "text", "text": "a"}}, "not_found"),
                         ({"chatId": GROUP, "clientId": "x", "content": {"kind": "text", "text": ""}}, "invalid_params"),
                         ({"chatId": GROUP, "clientId": "x", "content": {"kind": "video"}}, "invalid_params")]:
        with pytest.raises(RuntimeError, match=code):
            client.call("message/send", params)
    with pytest.raises(RuntimeError, match="method_not_found"):
        client.call("window/set", {"visible": True})
    assert client.call("account/status")["state"] == "ready", "still serving after errors"


def test_unreadable_databases_report_login_required_and_recover(tmp_path):
    root = tmp_path / "db_storage"
    client = Client("--plain", str(root), "--self", BOT, "--poll-ms", "50")
    try:
        client.call("initialize", {"protocolVersion": 1, "dataDir": str(tmp_path)})
        status = client.call("account/login")
        assert status["state"] == "login_required" and "登录" in status["instructions"]
        Account(root)  # the databases appear (WeChat logged in)
        assert client.next_event("event/account", timeout=10)["state"] == "ready"
    finally:
        client.close()
