import argparse
import asyncio
import os

from .db import Database, migrate


async def run(command: str):
    if command == "migrate":
        url = os.environ.get("DATABASE_MIGRATION_URL")
        if not url:
            raise SystemExit("Set DATABASE_MIGRATION_URL to the migration role DSN")
        await migrate(url)
        print("Applied the gateway schema.")
        return

    url = os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("Set DATABASE_URL to the runtime login DSN")
    db = await Database.connect(url)
    try:
        await db.health()
    finally:
        await db.close()
    print("Connected using the gateway runtime role.")


def main():
    parser = argparse.ArgumentParser(description="Manage the NLLint Postgres schema")
    parser.add_argument("command", choices=("migrate", "check"))
    asyncio.run(run(parser.parse_args().command))


if __name__ == "__main__":
    main()
