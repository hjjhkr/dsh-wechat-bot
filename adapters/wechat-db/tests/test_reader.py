import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fixtures import BOT, GROUP, Account, at_source, zstd  # noqa: E402
from wechat_db.content import mentions  # noqa: E402
from wechat_db.reader import Reader  # noqa: E402
from wechat_db.source import PlainSource  # noqa: E402


@pytest.fixture
def account(tmp_path):
    return Account(tmp_path / "db_storage")


@pytest.fixture
def reader(account):
    return Reader(PlainSource(account.root), BOT)


def test_chat_catalog_lists_chats_with_messages_and_skips_system_accounts(account, reader):
    account.add(GROUP, "wxid_alice", "大家好")
    account.add("wxid_friend", "wxid_friend", "在吗", prefix=False)
    account.add("gh_news", "gh_news", "推送", prefix=False)
    chats = reader.chats()
    assert chats == [
        {"id": GROUP, "name": "测试群", "kind": "group", "memberCount": 3},
        {"id": "wxid_friend", "name": "老朋友", "kind": "direct"},
    ]
    assert {m["id"]: m["name"] for m in reader.members(GROUP)} == {"wxid_alice": "阿离", "wxid_bob": "鲍哥", BOT: "小鲸鱼"}
    assert reader.self_info() == {"id": BOT, "name": "小鲸鱼"}


def test_group_text_strips_the_sender_prefix_and_decompresses(account, reader):
    plain = account.add(GROUP, "wxid_alice", "第一句")
    packed = account.add(GROUP, "wxid_bob", "很长很长的一段话" * 50, compress=True)
    messages = {m["id"]: m for m in reader.history(GROUP, 10)}
    assert messages[plain]["text"] == "第一句"
    assert messages[plain]["sender"] == {"id": "wxid_alice", "name": "阿离"}
    assert messages[packed]["text"].startswith("很长很长的一段话")
    assert messages[packed]["sender"]["name"] == "鲍哥", "remark wins over nickname"
    assert messages[plain]["kind"] == "text" and messages[plain]["fromSelf"] is False


def test_messages_across_shards_are_ordered_and_each_shard_maps_its_own_senders(account, reader):
    # Different senders get Name2Id rowid 1 in different shards.
    account.add(GROUP, "wxid_bob", "在分片1", shard=1)
    account.add(GROUP, "wxid_alice", "在分片0", shard=0)
    account.add(GROUP, "wxid_bob", "又在分片1", shard=1)
    messages = reader.after(GROUP, 0)
    assert [m["text"] for _, m in messages] == ["在分片1", "在分片0", "又在分片1"]
    assert [m["sender"]["id"] for _, m in messages] == ["wxid_bob", "wxid_alice", "wxid_bob"]
    seqs = [seq for seq, _ in messages]
    assert seqs == sorted(seqs)
    assert reader.after(GROUP, seqs[1]) == messages[1:], "inclusive: the caller de-duplicates the boundary"
    assert reader.latest_seq(GROUP) == seqs[-1]


def test_mentions_come_from_message_metadata_not_text(account, reader):
    account.add(GROUP, "wxid_alice", "@小鲸鱼 在吗", source=at_source(BOT))
    account.add(GROUP, "wxid_alice", "@小鲸鱼 这句只是正文里写了@")
    account.add(GROUP, "wxid_alice", "开会了", source=at_source("notify@all"))
    first, second, third = (m for _, m in reader.after(GROUP, 0))
    assert first["mentions"] == [BOT]
    assert second["mentions"] == []
    assert third["mentions"] == ["all"]
    assert mentions(b"<msgsource><silence>1</silence></msgsource>") == []
    assert mentions(zstd("garbage <<<")) == []


def test_quote_of_the_bot_carries_the_quoted_id_and_sender(account, reader):
    original = account.add(GROUP, BOT, "我是小鲸鱼")
    reply = account.quote(GROUP, "wxid_bob", "那你会啥", original, BOT, "小鲸鱼", "我是小鲸鱼")
    message = {m["id"]: m for m in reader.history(GROUP, 10)}[reply]
    assert message["kind"] == "text"
    assert message["text"] == "那你会啥"
    assert message["quote"] == {"messageId": original, "senderId": BOT, "senderName": "小鲸鱼", "text": "我是小鲸鱼"}
    assert {m["id"]: m for m in reader.history(GROUP, 10)}[original]["fromSelf"] is True


def test_stickers_images_and_system_messages_become_typed_messages(account, reader):
    account.add(GROUP, "wxid_alice", '<msg><emoji md5="abc123" desc="狗头" cdnurl="http://x"/></msg>', local_type=47)
    account.add(GROUP, "wxid_alice", '<msg><img md5="ffff" length="100"/></msg>', local_type=3)
    account.add(GROUP, "wxid_alice", '"阿离"邀请"老鲍"加入了群聊', local_type=10000, prefix=False)
    account.add(GROUP, "wxid_alice", b"\x00\x01binary", local_type=(17 << 32) | 11000)
    sticker, image, system, new_sticker = (m for _, m in reader.after(GROUP, 0))
    assert sticker["kind"] == "sticker" and sticker["media"] == {"mime": "image/gif", "description": "狗头"}
    assert image["kind"] == "image" and image["media"]["mime"] == "image/jpeg"
    assert system["kind"] == "system" and "加入了群聊" in system["text"]
    assert new_sticker["kind"] == "sticker"


def test_a_message_without_server_id_gets_a_stable_shard_local_id(account, reader):
    message_id = account.add(GROUP, "wxid_alice", "离线消息", server_id=0)
    assert message_id.startswith("message_0.db:")
    assert reader.history(GROUP, 1)[0]["id"] == message_id
