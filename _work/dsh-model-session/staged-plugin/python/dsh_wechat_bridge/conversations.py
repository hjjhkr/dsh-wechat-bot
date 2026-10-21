"""Account-scoped conversation metadata and one explicit hidden-desktop selection."""
import ctypes
import hashlib
import time

from .db_reader import verify_target_contact
from .group import GROUP_ID, USER_ID, group_members
from .uia_send import UiaSendError


def catalog(db, bot):
    # Table names establish an existing conversation without reading its messages.
    tables = set()
    for rel in db._message_dbs():
        conn = db._open(rel)
        try:
            tables.update(row[0] for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'"))
        finally:
            conn.close()
    conn = db._contact_conn()
    if conn is None:
        raise RuntimeError("conversation_contacts_unavailable")
    try:
        rows = conn.execute("SELECT username,nick_name,remark FROM contact").fetchall()
    finally:
        conn.close()
    result = []
    for identity, nickname, remark in rows:
        if not isinstance(identity, str) or identity == bot:
            continue
        if not (GROUP_ID.fullmatch(identity) or USER_ID.fullmatch(identity)):
            continue
        if identity in ("weixin", "newsapp", "fmessage", "medianote", "floatbottle"):
            continue
        table = "Msg_" + hashlib.md5(identity.encode()).hexdigest()
        if table not in tables:
            continue
        name = remark or nickname
        if not isinstance(name, str) or not name:
            raise RuntimeError("conversation_name_unavailable")
        result.append({"id": identity, "name": name,
                       "type": "group" if GROUP_ID.fullmatch(identity) else "direct"})
    return sorted(result, key=lambda row: (row["type"], row["name"], row["id"]))


def select_session(config, binding, db, gate, require_monitor):
    """Select only a unique visible session row; preserve drafts and never send."""
    if not config.get("desktopName"):
        raise UiaSendError("selection requires an isolated desktop", "gate_preflight")
    verify_target_contact(db, config["targetWxid"], config["targetName"])
    if config.get("conversationType") == "group":
        group_members(db, config["targetWxid"], config["botWxid"])
    # Display-name ambiguity cannot establish a reliable UI-to-account mapping.
    matches = [row for row in catalog(db, config["botWxid"]) if row["name"] == config["targetName"]]
    if len(matches) != 1 or matches[0]["id"] != config["targetWxid"]:
        raise UiaSendError("conversation display name is ambiguous", "gate_preflight")

    def action(active):
        import comtypes.client
        from wx4py.core import uiautomation as ui
        from wx4py.core.uia_wrapper import UIAWrapper
        from .isolated_send import live_click_plan
        from ctypes import wintypes
        require_monitor()
        client = ui._AutomationClient.instance()
        automation = comtypes.client.CreateObject(client.UIAutomationCore.CUIAutomation8,
                                                   interface=client.UIAutomationCore.IUIAutomation2)
        automation.AutoSetFocus = False
        automation.ConnectionTimeout = automation.TransactionTimeout = 2000
        client.IUIAutomation, client.ViewWalker = automation, automation.RawViewWalker
        root = UIAWrapper(binding["hwnd"]).root
        field = root.EditControl(AutomationId="chat_input_field", searchDepth=22)
        if not field.Exists(maxSearchSeconds=2):
            raise UiaSendError("current conversation input unavailable")
        if field.GetValuePattern().Value != "":
            raise UiaSendError("existing draft must be preserved")
        if field.Name != config["targetName"]:
            choices = []
            started = time.monotonic()
            for index, (control, _) in enumerate(ui.WalkControl(root, maxDepth=22)):
                if index > 500 or time.monotonic() - started > 12:
                    raise UiaSendError("conversation scan deadline")
                if index % 10 == 0:
                    active()
                    require_monitor()
                if control.ControlType == ui.ControlType.ListItemControl and control.Name.split("\n")[0] == config["targetName"]:
                    choices.append(control)
            if len(choices) != 1:
                raise UiaSendError("unique visible conversation required")
            user = ctypes.WinDLL("user32", use_last_error=True)
            packed = live_click_plan(user, binding["hwnd"], choices[0], expected_name=choices[0].Name)
            user.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
            user.PostMessageW.restype = wintypes.BOOL
            active()
            require_monitor()
            for message, wp in ((0x0200, 0), (0x0201, 1), (0x0202, 0)):
                if not user.PostMessageW(binding["hwnd"], message, wp, packed):
                    raise UiaSendError("conversation selection input failed")
            time.sleep(0.4)
            field = root.EditControl(AutomationId="chat_input_field", searchDepth=22)
        if not field.Exists(maxSearchSeconds=2) or field.Name != config["targetName"]:
            raise UiaSendError("selected conversation identity mismatch")
        if field.GetValuePattern().Value != "":
            raise UiaSendError("selected conversation contains a draft")
        active()
        require_monitor()
        return {"selected": True, "targetId": config["targetWxid"], "sent": False}
    result, restored = gate.run(action)
    return {**result, **restored}
