"""Run the two local development servers as one process lifecycle."""

import os
import signal
import subprocess
import sys
from time import sleep


def run(make: str) -> int:
    servers = []
    exit_status = None

    def interrupted(signum, _frame):
        nonlocal exit_status
        exit_status = 128 + signum

    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, interrupted)

    try:
        for target in ("api-dev", "vite"):
            servers.append(
                subprocess.Popen(
                    [make, "--no-print-directory", target],
                    start_new_session=True,
                )
            )
        while exit_status is None:
            for server in servers:
                if (status := server.poll()) is not None:
                    return status if status >= 0 else 128 - status
            sleep(0.2)
        return exit_status
    finally:
        for server in servers:
            try:
                os.killpg(server.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        for server in servers:
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(server.pid, signal.SIGKILL)
                server.wait()


if __name__ == "__main__":
    sys.exit(run(sys.argv[1]))
