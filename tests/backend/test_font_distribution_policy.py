"""Public releases must not expose third-party font binaries."""

from fastapi.testclient import TestClient

from main import app


def test_font_listing_and_download_routes_are_not_published() -> None:
    with TestClient(app) as client:
        assert client.get("/api/settings/fonts").status_code == 404
        assert client.get("/api/settings/fonts/download/example.ttf").status_code == 404
