# Kịch bản thu thập label — ChatGPT Admin (4 trang)

> **Mục đích:** Quét text label **một lần** cho 3 ngôn ngữ (vi / en / zh), lưu cố định vào database.  
> **Phạm vi:** 4 URL admin dưới đây.

---

## 0. Thông tin chung

### 0.1. Bốn trang cần thu thập

| # | URL | Mục đích |
|---|-----|----------|
| 1 | `https://chatgpt.com/admin/members` | Tab thành viên, mời, menu row, revoke |
| 2 | `https://chatgpt.com/admin/billing` | Tab kế hoạch, ghế, chu kỳ, trạng thái thanh toán |
| 3 | `https://chatgpt.com/admin/billing?tab=invoices` | Tab hóa đơn, lịch sử thanh toán |
| 4 | `https://chatgpt.com/admin/identity` | Toggle lời mời miền ngoài |

### 0.2. Ba lượt ngôn ngữ

| Lượt | `locale` | Cài đặt ChatGPT |
|------|----------|-----------------|
| 1 | `vi` | Tiếng Việt |
| 2 | `en` | English |
| 3 | `zh` | 中文 (简体) |

> Sau mỗi lần đổi ngôn ngữ: **F5** cả 4 trang.

### 0.3. Bảng ghi chép (mẫu)

| locale | page | control_key | label_text | aria_label | notes |
|--------|------|-------------|------------|------------|-------|
| vi | /admin/members | tab_active_members | | | |
| vi | /admin/members | invite_button_open | | | |

### 0.4. Script quét nhanh (DevTools → Console)

Chạy trên **từng trang**, sau khi mở dialog/menu (nếu có):

```javascript
(() => {
  const pick = (el) => {
    const text = (el.textContent ?? "").trim().replace(/\s+/g, " ");
    const aria = (el.getAttribute("aria-label") ?? "").trim();
    if (!text && !aria) return null;
    if (text.length > 120) return null;
    return { tag: el.tagName, role: el.getAttribute("role"), text, aria };
  };
  const sels = ["button", '[role="tab"]', '[role="menuitem"]', '[role="option"]', '[role="switch"]', "a"];
  const seen = new Set();
  const out = [];
  for (const sel of sels) {
    for (const el of document.querySelectorAll(sel)) {
      const row = pick(el);
      if (!row) continue;
      const key = `${row.role}|${row.text}|${row.aria}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
  }
  console.table(out);
  copy(JSON.stringify({ url: location.href, lang: document.documentElement.lang, items: out }, null, 2));
})();
```

---

## 1. Trang Members

**URL:** `https://chatgpt.com/admin/members`

### 1.1. Checklist label (control_key)

| control_key | Lấy khi nào | Ghi `label_text` |
|-------------|-------------|------------------|
| `tab_active_members` | Vào trang, tab đầu / tab active | |
| `tab_pending_invites` | Click tab thứ 2 | |
| `tab_pending_requests` | Click tab thứ 3 | |
| `invite_button_open` | Tab active, nút mời chính | |
| `invite_add_more_button` | Trong dialog invite (nếu có) | |
| `invite_role_owner` | Mở dropdown role trong dialog | |
| `invite_role_admin` | | |
| `invite_role_member` | | |
| `invite_submit_button` | Nút gửi trong dialog | |
| `member_row_menu_button` | Click `...` trên 1 dòng member | Ghi `aria_label` nếu không có chữ |
| `menu_remove_member` | Trong menu row | |
| `menu_change_role` | Trong menu row | |
| `confirm_remove_button` | Dialog xác nhận xóa (Cancel sau khi ghi) | |
| `menu_revoke_invite` | Tab pending invites → menu `...` | |
| `confirm_revoke_button` | Dialog revoke (nếu có) | |

### 1.2. Thứ tự thao tác

```
1. Mở /admin/members
2. Ghi 3 tab
3. Tab active → ghi invite_button_open
4. Click invite → ghi dialog (add_more, roles, submit) → đóng dialog
5. Tab active → menu ... trên 1 member → remove, change_role, confirm (hủy)
6. Tab pending invites → menu ... → revoke (hủy nếu không muốn xóa thật)
```

### 1.3. Dữ liệu sync (notes, không bắt buộc label)

| Ghi chú | Ví dụ (vi) |
|---------|------------|
| Số member active | đếm email sau scroll |
| Số pending invite | |
| Mẫu email trên row | `user@domain.com` |

---

## 2. Trang Billing — Kế hoạch

**URL:** `https://chatgpt.com/admin/billing`

> Không có `?tab=invoices` — tab mặc định / tab **Kế hoạch**.

### 2.1. Checklist label

| control_key | Ghi `label_text` |
|-------------|------------------|
| `tab_billing_plan` | Tab đang active (kế hoạch / gói) |
| `tab_billing_invoices` | Tab hóa đơn (chỉ ghi text tab, chưa cần click) |

### 2.2. Text scrape (ghi vào `notes`, không phải nút)

| key (notes) | Ví dụ vi | Ví dụ en | Ví dụ zh |
|-------------|----------|----------|----------|
| `billing_seat_ratio` | Đang dùng 6/8 giấy phép | Using 6/8 seats | … |
| `billing_plan_name` | Gói Business | Business plan | … |
| `billing_status` | Đã thanh toán / Chưa thanh toán | Paid / Unpaid | … |
| `billing_cycle` | Chu kỳ hiện tại: 11 thg 5 - 11 thg 6 | … | … |

### 2.3. Thứ tự

```
1. Mở /admin/billing
2. Đảm bảo đang tab Kế hoạch (click tab_billing_plan nếu cần)
3. Ghi label 2 tab + copy nguyên dòng ghế / gói / chu kỳ vào notes
```

---

## 3. Trang Billing — Hóa đơn

**URL:** `https://chatgpt.com/admin/billing?tab=invoices`

### 3.1. Checklist label

| control_key | Ghi `label_text` |
|-------------|------------------|
| `tab_billing_invoices` | Tab hóa đơn (đang active) |
| `tab_billing_plan` | Tab kế hoạch (để chuyển qua lại) |

### 3.2. Text scrape (notes)

| key (notes) | Mô tả |
|-------------|--------|
| `invoice_date_sample` | 1 ngày trên dòng hóa đơn |
| `invoice_amount_sample` | 1 số tiền (₫ / $ / ¥) |
| `invoice_status_sample` | Đã thanh toán / Paid / … |

### 3.3. Thứ tự

```
1. Mở URL có ?tab=invoices (hoặc click tab Hoá đơn từ /billing)
2. Ghi lại label 2 tab
3. Copy 1 dòng hóa đơn mẫu vào notes
```

---

## 4. Trang Identity

**URL:** `https://chatgpt.com/admin/identity`

### 4.1. Checklist label

| control_key | Ghi `label_text` |
|-------------|------------------|
| `toggle_external_invites` | **Cả câu** bên cạnh switch (không chỉ ON/OFF) |

### 4.2. Thứ tự

```
1. Mở /admin/identity
2. Tìm switch "Cho phép lời mời từ miền bên ngoài" (hoặc bản en/zh)
3. Ghi nguyên văn label → toggle_external_invites
4. (Tuỳ chọn) ghi aria-checked khi OFF và khi ON — không bật/tắt nếu không cần
```

---

## 5. Ma trận hoàn thành (3 ngôn ngữ × 4 trang)

### 5.1. Members — `https://chatgpt.com/admin/members`

| control_key | vi ☐ | en ☐ | zh ☐ |
|-------------|------|------|------|
| tab_active_members | | | |
| tab_pending_invites | | | |
| tab_pending_requests | | | |
| invite_button_open | | | |
| invite_add_more_button | | | |
| invite_role_owner | | | |
| invite_role_admin | | | |
| invite_role_member | | | |
| invite_submit_button | | | |
| member_row_menu_button | | | |
| menu_remove_member | | | |
| menu_change_role | | | |
| confirm_remove_button | | | |
| menu_revoke_invite | | | |
| confirm_revoke_button | | | |

### 5.2. Billing plan — `https://chatgpt.com/admin/billing`

| control_key / notes | vi ☐ | en ☐ | zh ☐ |
|---------------------|------|------|------|
| tab_billing_plan | | | |
| tab_billing_invoices | | | |
| billing_seat_ratio (notes) | | | |
| billing_plan_name (notes) | | | |
| billing_status (notes) | | | |
| billing_cycle (notes) | | | |

### 5.3. Billing invoices — `https://chatgpt.com/admin/billing?tab=invoices`

| control_key / notes | vi ☐ | en ☐ | zh ☐ |
|---------------------|------|------|------|
| tab_billing_invoices | | | |
| invoice_date_sample (notes) | | | |
| invoice_amount_sample (notes) | | | |
| invoice_status_sample (notes) | | | |

### 5.4. Identity — `https://chatgpt.com/admin/identity`

| control_key | vi ☐ | en ☐ | zh ☐ |
|-------------|------|------|------|
| toggle_external_invites | | | |

---

## 6. Lịch chạy một buổi

| Bước | Thời gian | Việc |
|------|-----------|------|
| A | 5 phút | Đặt ngôn ngữ **vi**, mở lần lượt 4 URL |
| B | 25 phút | Điền bảng **vi** (members → billing → invoices → identity) |
| C | 25 phút | Đổi **en**, lặp 4 URL |
| D | 25 phút | Đổi **zh**, lặp 4 URL |
| E | 10 phút | Kiểm tra đủ ☐, export JSON |

**Tổng label DB (ước tính):** ~15 (members) + ~2 (billing tab) + ~1 (identity) ≈ **18 control_key × 3 locale ≈ 54 dòng** (+ vài dòng notes scrape).

---

## 7. Mẫu JSON gửi API (theo từng trang)

### 7.1. Members (`locale: vi`)

```json
{
  "locale": "vi",
  "page": "/admin/members",
  "labels": [
    { "control_key": "tab_active_members", "label_text": "" },
    { "control_key": "tab_pending_invites", "label_text": "" },
    { "control_key": "tab_pending_requests", "label_text": "" },
    { "control_key": "invite_button_open", "label_text": "" },
    { "control_key": "invite_add_more_button", "label_text": "" },
    { "control_key": "invite_role_owner", "label_text": "" },
    { "control_key": "invite_role_admin", "label_text": "" },
    { "control_key": "invite_role_member", "label_text": "" },
    { "control_key": "invite_submit_button", "label_text": "" },
    { "control_key": "member_row_menu_button", "label_text": "", "aria_label": "" },
    { "control_key": "menu_remove_member", "label_text": "" },
    { "control_key": "menu_change_role", "label_text": "" },
    { "control_key": "confirm_remove_button", "label_text": "" },
    { "control_key": "menu_revoke_invite", "label_text": "" },
    { "control_key": "confirm_revoke_button", "label_text": "" }
  ]
}
```

### 7.2. Billing plan

```json
{
  "locale": "vi",
  "page": "/admin/billing",
  "labels": [
    { "control_key": "tab_billing_plan", "label_text": "" },
    { "control_key": "tab_billing_invoices", "label_text": "" }
  ],
  "scrape_notes": {
    "billing_seat_ratio": "",
    "billing_plan_name": "",
    "billing_status": "",
    "billing_cycle": ""
  }
}
```

### 7.3. Billing invoices

```json
{
  "locale": "vi",
  "page": "/admin/billing?tab=invoices",
  "labels": [
    { "control_key": "tab_billing_invoices", "label_text": "" }
  ],
  "scrape_notes": {
    "invoice_date_sample": "",
    "invoice_amount_sample": "",
    "invoice_status_sample": ""
  }
}
```

### 7.4. Identity

```json
{
  "locale": "vi",
  "page": "/admin/identity",
  "labels": [
    { "control_key": "toggle_external_invites", "label_text": "" }
  ]
}
```

> Lặp 4 block trên với `"locale": "en"` và `"locale": "zh"`.

---

## 8. Lưu ý

1. **4 URL là bắt buộc** — billing tách 2 URL (plan vs invoices) vì ChatGPT có thể sticky tab.
2. Label dialog/menu chỉ lấy **sau khi mở** element đó.
3. Không đổi ngôn ngữ giữa một lượt `vi` / `en` / `zh`.
4. Tab có số đếm `"(12)"` — có thể lưu full text hoặc chỉ phần chữ.
5. Khi ChatGPT đổi UI → chỉ calibrate lại **page + locale** bị lỗi.

---

*Phiên bản: 4 trang admin · vi / en / zh · lưu DB một lần*
