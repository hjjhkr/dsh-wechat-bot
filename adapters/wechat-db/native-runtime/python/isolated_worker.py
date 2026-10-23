"""Internal child entry; launched only with STARTUPINFO.lpDesktop."""
import sys

from dsh_wechat_bridge.isolated import IsolatedWindowsRuntime
from dsh_wechat_bridge.worker import Worker, serve_jsonl


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise RuntimeError("isolated desktop argument required")
    serve_jsonl(worker=Worker(runtime=IsolatedWindowsRuntime(sys.argv[1])))
