"""Signal-safe container launcher honoring Cloud Run's PORT contract."""

from __future__ import annotations

import os

import uvicorn


def main() -> None:
    uvicorn.run(
        "deployment.app:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8080")),
        workers=1,
        access_log=False,
    )


if __name__ == "__main__":
    main()
