"""ETag / conditional GET cho GET /ui-labels/bundle (tồn đọng #3 harvest.md).

Mục tiêu: extension poll bundle định kỳ nhưng label gần tĩnh → khi version chưa
đổi phải trả 304 (không nạp bảng, không body). Khi có harvest mới → ETag đổi →
client nhận 200 kèm body mới.
"""

from fastapi.testclient import TestClient


def _create_workspace(client: TestClient, auth_header: dict) -> dict:
    resp = client.post(
        "/api/v1/workspaces",
        json={"name": "Labels WS", "plan": "business", "seat_total": 10},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _harvest(client: TestClient, ext_headers: dict, control_key: str, text: str) -> None:
    """Seed/đổi 1 label qua đúng đường extension dùng (POST /harvest)."""
    resp = client.post(
        "/api/v1/ui-labels/harvest",
        json={
            "locale": "vi",
            "pages": [
                {
                    "page": "/admin/members",
                    "labels": [{"control_key": control_key, "label_text": text}],
                }
            ],
        },
        headers=ext_headers,
    )
    assert resp.status_code == 200, resp.text


def test_bundle_returns_etag_and_304_on_match(client: TestClient, auth_header: dict):
    ws = _create_workspace(client, auth_header)
    ext_headers = {"X-API-KEY": ws["extension_api_key"]}

    # Bundle rỗng vẫn phải có ETag.
    r0 = client.get("/api/v1/ui-labels/bundle", headers=ext_headers)
    assert r0.status_code == 200, r0.text
    empty_etag = r0.headers.get("ETag")
    assert empty_etag, "phải set header ETag"
    assert r0.headers.get("Cache-Control") == "no-cache"

    # Gửi lại đúng ETag → 304, không body.
    r_304 = client.get(
        "/api/v1/ui-labels/bundle",
        headers={**ext_headers, "If-None-Match": empty_etag},
    )
    assert r_304.status_code == 304, r_304.text
    assert r_304.headers.get("ETag") == empty_etag
    assert not r_304.content  # 304 không có body


def test_bundle_etag_changes_after_harvest(client: TestClient, auth_header: dict):
    ws = _create_workspace(client, auth_header)
    ext_headers = {"X-API-KEY": ws["extension_api_key"]}

    _harvest(client, ext_headers, "invite_btn", "Mời")
    r1 = client.get("/api/v1/ui-labels/bundle", headers=ext_headers)
    assert r1.status_code == 200
    etag1 = r1.headers["ETag"]
    body1 = r1.json()

    # ETag hiện tại → 304.
    r_same = client.get(
        "/api/v1/ui-labels/bundle",
        headers={**ext_headers, "If-None-Match": etag1},
    )
    assert r_same.status_code == 304

    # Harvest thay đổi label (bump version) → ETag đổi → client cũ nhận 200 mới.
    _harvest(client, ext_headers, "invite_btn", "Mời thành viên")
    r_stale = client.get(
        "/api/v1/ui-labels/bundle",
        headers={**ext_headers, "If-None-Match": etag1},
    )
    assert r_stale.status_code == 200, "version đổi → không được trả 304"
    etag2 = r_stale.headers["ETag"]
    assert etag2 != etag1
    # version trong body phải khớp ETag (cùng công thức).
    assert f'"ui-labels-v{r_stale.json()["version"]}"' == etag2
    assert r_stale.json()["version"] != body1["version"]


def test_bundle_if_none_match_wildcard(client: TestClient, auth_header: dict):
    ws = _create_workspace(client, auth_header)
    ext_headers = {"X-API-KEY": ws["extension_api_key"]}
    _harvest(client, ext_headers, "remove_btn", "Xoá")

    # `*` khớp mọi resource đang tồn tại → 304.
    r = client.get(
        "/api/v1/ui-labels/bundle",
        headers={**ext_headers, "If-None-Match": "*"},
    )
    assert r.status_code == 304, r.text
