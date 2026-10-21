from __future__ import annotations

import json
import sys
from contextlib import redirect_stdout
from typing import Any, TextIO

from .diagnostics import safe_reason_code, safe_send_attempted, safe_focus_diagnostic


class Worker:
    """Own one process/account binding and enforce the host RPC contract."""

    def __init__(self, runtime: Any = None) -> None:
        self.runtime = runtime
        self._config: dict[str, Any] | None = None
        self._config_fingerprint: str | None = None
        self._session: Any = None
        self._send_attempts: dict[str, dict[str, Any]] = {}
        self._send_locked = False
        self._closed = False
        self._close_result: dict[str, Any] | None = None

    def handle(self, request: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(request, dict):
            return self._error("invalid_request", "request must be an object")
        method = request.get("method")
        params = request.get("params")
        if not isinstance(params, dict):
            return self._error("invalid_request", "params must be an object")
        if method == "close":
            return self._close()
        if self._closed:
            return self._error("closed", "worker is closed")
        if method == "send" and not (
            params.get("enableSend") is True
            and params.get("allowTemporaryGate") is True
        ):
            return self._error("send_disabled", "both send permissions are required")
        try:
            if method == "probe":
                return self._probe(params)
            if method in ("baseline", "poll", "send", "conversations", "select"):
                self._require_session(params)
                if method == "conversations":
                    return {"result": self.runtime.conversations(self._config, self._session)}
                if method == "select":
                    if params.get("allowTemporaryGate") is not True or params.get("selectionConfirmed") is not True:
                        raise RpcFailure("selection_consent_required", "explicit selection permission required")
                    if self._send_locked:
                        raise RpcFailure("selection_send_uncertain", "resolve the outstanding send first")
                    return {"result": self.runtime.select(self._config, self._session, params)}
                if method == "baseline":
                    self.runtime.verify(self._config, self._session)
                    result = self.runtime.baseline(self._config, self._session)
                    self._validate_identity_result(result)
                    return {"result": result}
                if method == "poll":
                    self.runtime.verify(self._config, self._session)
                    result = self.runtime.poll(
                        self._config,
                        self._session,
                        params.get("cursor"),
                        params.get("overlapSeq", 1),
                        params.get("maxItems", 1000),
                    )
                    return {"result": self._validate_poll(result, params)}
                return self._send(params)
            return self._error("unknown_method", "unsupported method")
        except RpcFailure as exc:
            return self._error(exc.code, exc.message)
        except Exception:
            # Never return library errors that can contain paths or key material.
            return self._error("worker_error", "request failed; inspect worker diagnostics")

    def _probe(self, params: dict[str, Any]) -> dict[str, Any]:
        if self._session is not None:
            raise RpcFailure("already_probed", "close the current binding before probing again")
        config = validate_config(params.get("config"))
        if self.runtime is None:
            if "desktopName" in config:
                from .isolated import IsolatedRuntime
                self.runtime = IsolatedRuntime()
            else:
                from .runtime import WindowsRuntime
                self.runtime = WindowsRuntime()
        result = self.runtime.probe(config)
        self._validate_identity_result(result, config)
        self._config = config
        self._config_fingerprint = _fingerprint(config)
        self._session = result
        return {"result": result}

    def _require_session(self, params: dict[str, Any]) -> None:
        if self._session is None or self._config is None:
            raise RpcFailure("not_probed", "probe must succeed first")
        request_config = params.get("config")
        if request_config is not None:
            config = validate_config(request_config)
            if _fingerprint(config) != self._config_fingerprint:
                raise RpcFailure("config_changed", "configuration changed; probe again")

    def _validate_identity_result(
        self, result: Any, config: dict[str, Any] | None = None
    ) -> None:
        expected = config or self._config
        if not isinstance(result, dict) or expected is None:
            raise RpcFailure("invalid_runtime_result", "runtime identity result is invalid")
        if result.get("selfId") != expected["botWxid"] or result.get("targetId") != expected["targetWxid"]:
            raise RpcFailure("scope_violation", "runtime identity does not match configured scope")

    def _validate_poll(self, result: Any, params: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(result, dict) or not isinstance(result.get("messages"), list):
            raise RpcFailure("invalid_runtime_result", "poll result is invalid")
        cursor = params.get("cursor")
        if not isinstance(cursor, dict) or type(cursor.get("sortSeq")) is not int or cursor["sortSeq"] < 0:
            raise RpcFailure("invalid_cursor", "cursor.sortSeq must be a nonnegative integer")
        overlap = params.get("overlapSeq", 1)
        max_items = params.get("maxItems", 1000)
        if type(overlap) is not int or overlap < 0 or overlap > 100000:
            raise RpcFailure("invalid_poll_limit", "overlapSeq is out of range")
        if type(max_items) is not int or max_items < 1 or max_items > 10000:
            raise RpcFailure("invalid_poll_limit", "maxItems must be between 1 and 10000")
        messages = result["messages"]
        if len(messages) >= max_items or result.get("complete") is not True:
            raise RpcFailure("poll_saturated", "poll reached its safety limit; cursor was not advanced")
        validated = []
        previous = -1
        for item in messages:
            if not isinstance(item, dict):
                raise RpcFailure("invalid_runtime_result", "poll item is invalid")
            sender = item.get("senderId")
            if (
                item.get("bot") != self._config["botWxid"]
                or item.get("target") != self._config["targetWxid"]
                or (self._config.get("conversationType", "direct") == "direct" and
                    sender not in (self._config["botWxid"], self._config["targetWxid"]))
                or (self._config.get("conversationType") == "group" and (
                    not isinstance(sender, str) or not sender or sender.endswith("@chatroom") or
                    item.get("isGroupMember") is not True or type(item.get("mentionedBot")) is not bool or
                    not isinstance(item.get("senderName"), str)))
                or item.get("isSelf") is not (sender == self._config["botWxid"])
                or not isinstance(item.get("shard"), str)
                or not item.get("shard")
                or type(item.get("local_id")) is not int
                or type(item.get("sort_seq")) is not int
                or item["sort_seq"] < previous
                or not isinstance(item.get("text"), str)
                or type(item.get("timestamp")) is not int
            ):
                raise RpcFailure("scope_violation", "poll returned an invalid or out-of-scope message")
            previous = item["sort_seq"]
            validated.append(item)
        next_cursor = result.get("nextCursor")
        if (
            not isinstance(next_cursor, dict)
            or type(next_cursor.get("sortSeq")) is not int
            or next_cursor["sortSeq"] < cursor["sortSeq"]
            or next_cursor["sortSeq"] < previous
        ):
            raise RpcFailure("invalid_runtime_result", "nextCursor is invalid")
        if result.get("complete") is not True:
            next_cursor = cursor
        checked = {"messages": validated, "nextCursor": next_cursor, "complete": True}
        if "desktopAvailable" in result:
            if type(result["desktopAvailable"]) is not bool:
                raise RpcFailure("invalid_runtime_result", "desktop availability is invalid")
            checked["desktopAvailable"] = result["desktopAvailable"]
        return checked

    def _send(self, params: dict[str, Any]) -> dict[str, Any]:
        if params.get("hostAttemptPersisted") is not True:
            raise RpcFailure("attempt_marker_required", "host must persist the attempt marker before send")
        attempt_id = params.get("attemptId")
        target = params.get("target")
        text = params.get("text")
        if not isinstance(attempt_id, str) or not attempt_id.strip():
            raise RpcFailure("invalid_attempt", "attemptId is required")
        if attempt_id in self._send_attempts:
            return {"result": self._send_attempts[attempt_id]}
        if self._send_locked:
            return {"result": {
                "status": "ambiguous", "reasonCode": "send_unknown", "sendAttempted": None,
                "gateActive": None, "gateRestored": False,
            }}
        if target != self._config["targetWxid"]:
            raise RpcFailure("scope_violation", "send target is outside the configured scope")
        if params.get("expectedSelfId") != self._config["botWxid"]:
            raise RpcFailure("scope_violation", "expected sender does not match the bound bot")
        if not isinstance(text, str) or not text or len(text) > 4096:
            raise RpcFailure("invalid_text", "text must contain 1 to 4096 characters")
        if "gateRva" not in self._config or "gateExpectedOriginalByte" not in self._config:
            raise RpcFailure("gate_config_required", "temporary gate settings are missing")
        self._send_locked = True
        self._send_attempts[attempt_id] = {
            "status": "ambiguous",
            "reasonCode": "send_unknown",
            "sendAttempted": None,
            "gateActive": None,
            "gateRestored": False,
        }
        outcome = None
        try:
            self.runtime.verify(self._config, self._session)
        except Exception:
            checked = {
                "status": "ambiguous", "reasonCode": "gate_preflight", "sendAttempted": False,
                "gateActive": False, "gateRestored": True,
            }
        else:
            try:
                outcome = self.runtime.send(self._config, self._session, params)
                checked = self._validate_send_outcome(outcome, target, text)
            except Exception:
                checked = {
                    "status": "ambiguous", "reasonCode": "send_unknown", "sendAttempted": None,
                    "gateActive": None, "gateRestored": False,
                }
        if isinstance(outcome, dict) and (
            outcome.get("gateActive") is not False
            or outcome.get("gateRestored") is not True
        ):
            checked = {
                "status": "ambiguous", "reasonCode": "gate_restore",
                "sendAttempted": safe_send_attempted(outcome.get("sendAttempted")),
                "gateActive": outcome.get("gateActive"),
                "gateRestored": outcome.get("gateRestored") is True,
            }
        if isinstance(outcome, dict):
            diagnostic = safe_focus_diagnostic(outcome.get("focusDiagnostic"))
            if diagnostic is not None:
                checked["focusDiagnostic"] = diagnostic
        if checked["status"] == "blocked":
            self._send_locked = False
            self._send_attempts.pop(attempt_id, None)
            return {"result": checked}
        if checked["status"] == "confirmed":
            self._send_locked = False
        self._send_attempts[attempt_id] = checked
        return {"result": checked}

    def _validate_send_outcome(
        self, outcome: Any, target: str, text: str
    ) -> dict[str, Any]:
        if not isinstance(outcome, dict):
            return {
                "status": "ambiguous", "reasonCode": "send_unknown", "sendAttempted": None,
                "gateActive": None, "gateRestored": False,
            }
        gate_active = outcome.get("gateActive")
        gate_restored = outcome.get("gateRestored") is True
        send_attempted = safe_send_attempted(outcome.get("sendAttempted"))
        if (outcome.get("status") == "blocked" and outcome.get("reasonCode") == "desktop_unavailable"
                and send_attempted is False and gate_active is False and gate_restored
                and outcome.get("outgoing") is None):
            return {"status": "blocked", "reasonCode": "desktop_unavailable", "sendAttempted": False,
                    "gateActive": False, "gateRestored": True}
        if outcome.get("status") != "confirmed":
            return {
                "status": "ambiguous",
                "reasonCode": safe_reason_code(outcome.get("reasonCode")),
                "sendAttempted": send_attempted,
                "gateActive": gate_active,
                "gateRestored": gate_restored,
            }
        if gate_active is not False or not gate_restored:
            return {
                "status": "ambiguous", "reasonCode": "gate_restore",
                "sendAttempted": send_attempted,
                "gateActive": gate_active, "gateRestored": gate_restored,
            }
        outgoing = outcome.get("outgoing")
        if not isinstance(outgoing, dict):
            return {
                "status": "ambiguous", "reasonCode": "db_verify", "sendAttempted": send_attempted,
                "gateActive": gate_active, "gateRestored": gate_restored,
            }
        server_id = outgoing.get("serverId")
        if (
            outgoing.get("target") != target
            or outgoing.get("senderId") != self._config["botWxid"]
            or outgoing.get("text") != text
            or not isinstance(server_id, str)
            or not server_id
            or not server_id.isascii()
            or not server_id.isdecimal()
            or server_id.startswith("0")
            or type(outgoing.get("localId")) is not int
            or type(outgoing.get("sortSeq")) is not int
            or not isinstance(outgoing.get("shard"), str)
            or not outgoing["shard"]
            or send_attempted is not True
        ):
            return {
                "status": "ambiguous", "reasonCode": "db_verify",
                "sendAttempted": send_attempted,
                "gateActive": gate_active,
                "gateRestored": gate_restored,
            }
        return {
            "status": "confirmed",
            "outgoing": outgoing,
            "sendAttempted": True,
            "gateActive": False,
            "gateRestored": True,
        }

    def _close(self) -> dict[str, Any]:
        if self._closed:
            return {"result": dict(self._close_result or {"closed": True, "gateActive": False})}
        runtime = self.runtime
        if runtime is not None:
            try:
                state = runtime.close()
            except Exception:
                return self._error("close_failed", "runtime cleanup reported an error")
            if (
                not isinstance(state, dict)
                or state.get("closed") is not True
                or state.get("gateActive") is not False
                or state.get("gateRestored") is not True
            ):
                return self._error("close_failed", "worker closure or gate restoration is unconfirmed")
        self._closed = True
        self._close_result = {"closed": True, "gateActive": False, "gateRestored": True}
        self._session = None
        self._config = None
        self._config_fingerprint = None
        return {"result": dict(self._close_result)}

    @staticmethod
    def _error(code: str, message: str) -> dict[str, Any]:
        return {"error": {"code": code, "message": message}}


class RpcFailure(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def validate_config(raw: Any) -> dict[str, Any]:
    required = (
        "dbRoot",
        "stateRoot",
        "keyCacheFile",
        "botWxid",
        "botName",
        "targetWxid",
        "targetName",
        "expectedExe",
        "expectedVersion",
        "mainWindowClass",
        "mainWindowTitle",
        "gateModule",
        "gateRva",
        "gateTimeoutSeconds",
    )
    required_strings = (
        "dbRoot", "stateRoot", "keyCacheFile", "botWxid", "botName",
        "targetWxid", "targetName", "expectedExe", "expectedVersion", "gateModule",
        "mainWindowClass", "mainWindowTitle",
    )
    if not isinstance(raw, dict) or any(not isinstance(raw.get(key), str) for key in required_strings):
        raise RpcFailure("invalid_config", "worker config is missing required strings")
    for key in ("dbRoot", "stateRoot", "keyCacheFile", "expectedExe", "gateModule"):
        from pathlib import Path

        if not Path(raw[key]).is_absolute():
            raise RpcFailure("invalid_config", f"{key} must be an absolute path")
    timeout = raw.get("gateTimeoutSeconds")
    if type(timeout) not in (int, float) or not (1 <= timeout <= 30):
        raise RpcFailure("invalid_config", "gateTimeoutSeconds must be between 1 and 30")
    if (
        not raw["botWxid"]
        or not raw["targetWxid"]
        or raw["botWxid"] == raw["targetWxid"]
    ):
        raise RpcFailure("invalid_config", "bot and target identities must be distinct")
    from .group import GROUP_ID
    mode = raw.get("conversationType", "direct")
    if mode not in ("direct", "group") or (mode == "group") != raw["targetWxid"].endswith("@chatroom"):
        raise RpcFailure("invalid_config", "conversation type and target identity differ")
    if mode == "group" and not GROUP_ID.fullmatch(raw["targetWxid"]):
        raise RpcFailure("invalid_config", "group identity invalid")
    if not raw["botName"] or not raw["targetName"] or not raw["expectedVersion"]:
        raise RpcFailure("invalid_config", "names and expectedVersion are required")
    if not isinstance(raw["gateRva"], (int, str)):
        raise RpcFailure("invalid_config", "gateRva must be an integer or hexadecimal string")
    for key in ("gateExpectedOriginalByte", "gateEnabledByte"):
        if key not in raw or type(raw[key]) is not int or not 0 <= raw[key] <= 255:
            raise RpcFailure("invalid_config", f"{key} must be a byte")
    if raw["gateExpectedOriginalByte"] == raw["gateEnabledByte"]:
        raise RpcFailure("invalid_config", "gate bytes must differ")
    if Path(raw["gateModule"]).name.lower() != "weixin.dll":
        raise RpcFailure("invalid_config", "gateModule must be the Weixin.dll path")
    if "desktopName" in raw:
        from .desktop import validate_desktop
        try:
            validate_desktop(raw["desktopName"])
        except ValueError:
            raise RpcFailure("invalid_config", "isolated desktop name is invalid") from None
    return dict(raw)


def _fingerprint(config: dict[str, Any]) -> str:
    return json.dumps(config, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def serve_jsonl(
    stdin: TextIO = sys.stdin,
    stdout: TextIO = sys.stdout,
    worker: Worker | None = None,
) -> None:
    worker = worker or Worker()
    try:
        for line in stdin:
            try:
                request = json.loads(line)
            except json.JSONDecodeError:
                response = Worker._error("invalid_json", "invalid JSON line")
                request_id = None
            else:
                request_id = request.get("id") if isinstance(request, dict) else None
                try:
                    with redirect_stdout(sys.stderr):
                        response = worker.handle(request)
                except Exception:
                    response = Worker._error("internal_error", "request failed")
            if not isinstance(response, dict):
                response = Worker._error("internal_error", "invalid worker response")
            if "error" in response:
                reply = {"id": request_id, "error": response["error"]}
            else:
                reply = {"id": request_id, "result": response.get("result")}
            stdout.write(json.dumps(reply, ensure_ascii=False, separators=(",", ":")) + "\n")
            stdout.flush()
    finally:
        if not worker._closed:
            with redirect_stdout(sys.stderr):
                worker._close()


def main() -> int:
    serve_jsonl()
    return 0
