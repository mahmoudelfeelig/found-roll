"""Cloud Run entry point serving the product UI and custody API as one service."""

import os
from pathlib import Path

from fastapi.staticfiles import StaticFiles

from app.main import app


CLIENT_DIR = Path(__file__).resolve().parents[1] / "dist" / "client"
CLIENT_INDEX = CLIENT_DIR / "index.html"

if CLIENT_INDEX.is_file():
    # Mount last so every explicit API, task, callback, health, and OpenAPI route
    # keeps precedence. Found Roll uses query-string surface selection, so the
    # static index is sufficient without a broad API fallback.
    app.mount("/", StaticFiles(directory=CLIENT_DIR, html=True), name="found-roll-web")
elif os.getenv("FOUND_ROLL_ENV", "development").strip().lower() == "production":
    raise RuntimeError("Production startup requires the built Found Roll client index.")
