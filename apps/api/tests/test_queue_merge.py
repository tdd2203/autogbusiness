"""GỘP LỆNH CÙNG LOẠI trong hàng đợi (user 2026-08-28).

Yêu cầu gốc: đang chạy một lệnh mời mà phía sau còn nhiều lệnh mời nữa thì cho
gộp lại mời MỘT lần, miễn tổng số suất không vượt số suất workspace đang có; vượt
thì để lệnh đó chạy sau. Lệnh gỡ / đổi email cũng vậy, nhưng chỉ gộp với lệnh
CÙNG LOẠI. Hàng đợi `mời · gỡ · mời · mời · gỡ · mời` phải gộp được ba lệnh mời
đang chờ với nhau dù chúng không nằm liền nhau.

Điều phải khoá chặt nhất KHÔNG phải chuyện gộp được hay không, mà là: payload
trong DB của TỪNG lệnh không được trộn email của nhau. Tiền của một lời mời trỏ
vào đúng lệnh sinh ra nó — trộn payload là mọi đường hoàn phí/dọn bản ghi ma trỏ
sai chỗ.
"""

from fastapi.testclient import TestClient


def _ws(client: TestClient, auth_header: dict, name: str, seat_total: int | None = 50) -> dict:
    resp = client.post(
        "/api/v1/workspaces",
        json={"name": name, "plan": "business", "seat_total": seat_total},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _task(
    client: TestClient, auth_header: dict, ws: dict, type_: str, payload: dict
) -> str:
    resp = client.post(
        "/api/v1/queue",
        json={"type": type_, "workspace_id": ws["id"], "payload": payload},
        headers=auth_header,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def _invite(
    client: TestClient, auth_header: dict, ws: dict, email: str, **extra
) -> str:
    payload = {"email": email, "role": "member", "new_seat_count": 1, **extra}
    return _task(client, auth_header, ws, "INVITE_MEMBER", payload)


def _next(client: TestClient, ws: dict, merge: bool = True) -> dict | None:
    resp = client.get(
        f"/api/v1/queue/next{'?merge=1' if merge else ''}",
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _get_task(client: TestClient, auth_header: dict, ws: dict, task_id: str) -> dict:
    resp = client.get(
        f"/api/v1/queue?workspace_id={ws['id']}&limit=100", headers=auth_header
    )
    assert resp.status_code == 200, resp.text
    items = resp.json()
    items = items["items"] if isinstance(items, dict) else items
    found = [i for i in items if i["id"] == task_id]
    assert found, f"không thấy task {task_id}"
    return found[0]


def test_gop_ba_lenh_moi_dang_cho_du_khong_nam_lien_nhau(client, auth_header):
    """Hàng đợi mời · gỡ · mời · mời · gỡ · mời → mẻ đầu gộp đúng 4 lệnh MỜI.

    (Lệnh 1 chính là lệnh dẫn đầu của mẻ; ba lệnh mời phía sau được kéo vào cùng.
    Hai lệnh gỡ nằm xen giữa KHÔNG bị đụng tới.)
    """
    ws = _ws(client, auth_header, "Gộp mời")
    m1 = _invite(client, auth_header, ws, "m1@x.com")
    g1 = _task(client, auth_header, ws, "REMOVE_MEMBER", {"email": "g1@x.com"})
    m3 = _invite(client, auth_header, ws, "m3@x.com")
    m4 = _invite(client, auth_header, ws, "m4@x.com")
    g2 = _task(client, auth_header, ws, "REMOVE_MEMBER", {"email": "g2@x.com"})
    m6 = _invite(client, auth_header, ws, "m6@x.com")

    task = _next(client, ws)
    assert task["id"] == m1
    assert [t["id"] for t in task["payload"]["merged_tasks"]] == [m1, m3, m4, m6]
    assert task["payload"]["emails"] == ["m1@x.com", "m3@x.com", "m4@x.com", "m6@x.com"]
    assert task["payload"]["new_seat_count"] == 4

    # Lệnh gỡ vẫn nằm chờ; lệnh mời được gộp đã sang IN_PROGRESS.
    assert _get_task(client, auth_header, ws, g1)["status"] == "PENDING"
    assert _get_task(client, auth_header, ws, g2)["status"] == "PENDING"
    for tid, email in ((m3, "m3@x.com"), (m4, "m4@x.com"), (m6, "m6@x.com")):
        row = _get_task(client, auth_header, ws, tid)
        assert row["status"] == "IN_PROGRESS"
        assert row["payload"]["merged_into"] == m1
        # PAYLOAD TRONG DB giữ NGUYÊN email của riêng lệnh đó — bất biến số 1:
        # tiền của lời mời trỏ vào đúng lệnh sinh ra nó.
        assert row["payload"]["email"] == email
        assert "emails" not in row["payload"]

    # Mẻ kế tiếp: hai lệnh gỡ gộp với nhau, không dính lệnh mời nào.
    nxt = _next(client, ws)
    assert nxt["id"] == g1
    assert [t["id"] for t in nxt["payload"]["merged_tasks"]] == [g1, g2]
    assert nxt["payload"]["emails"] == ["g1@x.com", "g2@x.com"]


def test_khong_du_suat_thi_de_lenh_do_lai(client, auth_header):
    """Tổng suất của mẻ không được vượt số suất còn trống."""
    ws = _ws(client, auth_header, "Ít suất", seat_total=2)
    a = _invite(client, auth_header, ws, "a@x.com")
    b = _invite(client, auth_header, ws, "b@x.com")
    c = _invite(client, auth_header, ws, "c@x.com")

    task = _next(client, ws)
    assert task["id"] == a
    assert [t["id"] for t in task["payload"]["merged_tasks"]] == [a, b]
    assert _get_task(client, auth_header, ws, c)["status"] == "PENDING"


def test_lenh_dan_dau_phai_mua_suat_thi_chay_mot_minh(client, auth_header):
    """Riêng lệnh đầu đã vượt số suất trống ⇒ không kéo ai vào cửa mua suất."""
    ws = _ws(client, auth_header, "Hết suất", seat_total=1)
    a = _task(
        client,
        auth_header,
        ws,
        "INVITE_MEMBER",
        {"emails": ["a1@x.com", "a2@x.com"], "role": "member", "new_seat_count": 2},
    )
    b = _invite(client, auth_header, ws, "b@x.com")

    task = _next(client, ws)
    assert task["id"] == a
    assert "merged_tasks" not in task["payload"]
    assert _get_task(client, auth_header, ws, b)["status"] == "PENDING"


def test_chua_dong_bo_so_suat_thi_khong_gop_lenh_moi(client, auth_header):
    """`seat_total` NULL = không biết còn trống bao nhiêu → không đoán bừa."""
    ws = _ws(client, auth_header, "Chưa sync suất", seat_total=None)
    a = _invite(client, auth_header, ws, "a@x.com")
    _invite(client, auth_header, ws, "b@x.com")

    task = _next(client, ws)
    assert task["id"] == a
    assert "merged_tasks" not in task["payload"]


def test_khac_vai_tro_thi_khong_gop(client, auth_header):
    """Hộp mời của ChatGPT đặt MỘT vai trò cho cả lượt gửi."""
    ws = _ws(client, auth_header, "Khác role")
    a = _invite(client, auth_header, ws, "a@x.com")
    _invite(client, auth_header, ws, "b@x.com", role="admin")

    task = _next(client, ws)
    assert task["id"] == a
    assert "merged_tasks" not in task["payload"]


def test_trung_email_thi_khong_gop(client, auth_header):
    """Cùng một email ở hai lệnh: gộp vào là phí/bản ghi của hai lệnh dính nhau."""
    ws = _ws(client, auth_header, "Trùng email")
    a = _invite(client, auth_header, ws, "a@x.com")
    b = _invite(client, auth_header, ws, "a@x.com")

    task = _next(client, ws)
    assert task["id"] == a
    assert "merged_tasks" not in task["payload"]
    assert _get_task(client, auth_header, ws, b)["status"] == "PENDING"


def test_extension_cu_khong_bao_gio_nhan_me_gop(client, auth_header):
    """Không có `?merge=1` = bản cũ: nhận mẻ thì các lệnh còn lại kẹt IN_PROGRESS."""
    ws = _ws(client, auth_header, "Ext cũ")
    a = _invite(client, auth_header, ws, "a@x.com")
    b = _invite(client, auth_header, ws, "b@x.com")

    task = _next(client, ws, merge=False)
    assert task["id"] == a
    assert "merged_tasks" not in task["payload"]
    assert _get_task(client, auth_header, ws, b)["status"] == "PENDING"


def test_moi_lenh_trong_me_tu_bao_ket_qua_cua_rieng_no(client, auth_header):
    """Extension PATCH từng lệnh → mỗi lệnh kết thúc độc lập, đúng như chạy lẻ."""
    ws = _ws(client, auth_header, "Báo kết quả")
    a = _invite(client, auth_header, ws, "a@x.com")
    b = _invite(client, auth_header, ws, "b@x.com")
    task = _next(client, ws)
    assert [t["id"] for t in task["payload"]["merged_tasks"]] == [a, b]

    key = {"X-API-KEY": ws["extension_api_key"]}
    r1 = client.patch(
        f"/api/v1/queue/{a}",
        json={
            "status": "COMPLETED",
            "result": {"verified_count": 1, "unverified_emails": []},
        },
        headers=key,
    )
    assert r1.status_code == 200, r1.text
    r2 = client.patch(
        f"/api/v1/queue/{b}",
        json={
            "status": "FAILED",
            "error_code": "VERIFY_FAILED",
            "error_message": "không thấy trong tab Lời mời",
        },
        headers=key,
    )
    assert r2.status_code == 200, r2.text

    assert _get_task(client, auth_header, ws, a)["status"] == "COMPLETED"
    row_b = _get_task(client, auth_header, ws, b)
    assert row_b["status"] == "FAILED"
    assert row_b["error_code"] == "VERIFY_FAILED"


def test_nhip_song_cua_lenh_dan_dau_bom_sang_ca_me(client, auth_header):
    """Lệnh được gộp không tự báo tiến độ → phải ăn theo nhịp của lệnh dẫn đầu,
    không thì `pick_next` tưởng nó im lặng rồi dọn oan giữa lúc mẻ đang chạy."""
    ws = _ws(client, auth_header, "Nhịp mẻ")
    a = _invite(client, auth_header, ws, "a@x.com")
    b = _invite(client, auth_header, ws, "b@x.com")
    task = _next(client, ws)
    assert [t["id"] for t in task["payload"]["merged_tasks"]] == [a, b]

    before = _get_task(client, auth_header, ws, b)["progress"]["at"]
    resp = client.patch(
        f"/api/v1/queue/{a}/progress",
        json={"progress": {"phase": "submitting", "message": "đang gửi"}},
        headers={"X-API-KEY": ws["extension_api_key"]},
    )
    assert resp.status_code == 200, resp.text

    after = _get_task(client, auth_header, ws, b)
    assert after["progress"]["at"] > before
    # Chỉ chạm dấu nhịp — pha của lệnh dẫn đầu KHÔNG được ghi đè sang lệnh khác.
    assert after["progress"].get("phase") is None
