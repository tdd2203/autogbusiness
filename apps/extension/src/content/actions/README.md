# Extension actions

Folder này chứa **9 action entry-point** được dispatch từ background runner →
content script khi background pick task. Mỗi action có folder riêng + 1 file
[`README.md`](./) giải thích **logic, flow, lịch sử bug fix, debug tip**.

> **Nguyên tắc khi sửa code trong folder này:**
> 1. Mỗi action **PHẢI có README.md** kế bên code, mô tả đầy đủ flow + history.
> 2. Mỗi lần fix bug / thay đổi behavior → **PHẢI append entry vào section "Lịch sử sửa lỗi"** của README tương ứng (root cause + fix + why).
> 3. **PHẢI bump version** ở [`../../version.ts`](../../version.ts) + thêm entry [`apps/extension/CHANGELOG.md`](../../../CHANGELOG.md) — xem [Memory `feedback_extension_version_bump.md`].
> 4. **JSDoc trong code không thay thế cho README** — code comments là "what + how", README là "why + history".

## 9 actions

| # | Action | Folder | Message kind từ background | Mô tả ngắn |
|---|--------|--------|---------------------------|-----------|
| 1 | [change-role/](./change-role/README.md) | [`change-role/`](./change-role/) | `CHANGE_ROLE` | Đổi vai trò member qua inline dropdown trên row (UI 2026). |
| 2 | [revoke/](./revoke/README.md) | [`revoke/`](./revoke/) | `REVOKE_INVITES` | Thu hồi pending invite (1 hoặc nhiều email) trên tab Lời mời. |
| 3 | [external-invites/](./external-invites/README.md) | [`external-invites/`](./external-invites/) | *(wrapper, không phải dispatcher)* | Tạm bật toggle "Cho phép lời mời ngoài miền" cho invite, force OFF sau. |
| 4 | [remove/](./remove/README.md) | [`remove/`](./remove/) | `REMOVE_MEMBER` | Xoá member active qua filter "Lọc theo tên" → menu → confirm. |
| 5 | [sync-billing/](./sync-billing/README.md) | [`sync-billing/`](./sync-billing/) | `SYNC_BILLING` | Scrape seat/plan/billing_status/invoices từ `/admin/billing`. |
| 6 | [sync/](./sync/README.md) | [`sync/`](./sync/) | `SYNC_DATA` | Scrape toàn bộ member 3 tab (Người dùng/Lời mời/Yêu cầu). 5 phút cap. |
| 7 | [invite/](./invite/README.md) | [`invite/`](./invite/) | `INVITE_MEMBER` + `VERIFY_PENDING_INVITE` | 2-phase invite với F5 background giữa Phase 1 (submit) và Phase 2 (verify). |
| 8 | [purchase-seat/](./purchase-seat/README.md) | [`purchase-seat/`](./purchase-seat/) | `PURCHASE_SEAT` | ⚠️ CHARGE TIỀN THẬT — modal 1 +/- + modal 2 review + Stripe + Link chain. |
| 9 | [harvest-labels/](./harvest-labels/README.md) | [`harvest-labels/`](./harvest-labels/) | `HARVEST_LABELS` | Crawl 4 page ChatGPT lấy 18 control_key cho 1 locale → DB ui_labels. |

## Files dùng chung

| File | Mô tả |
|------|-------|
| [`member-row.ts`](./member-row.ts) | `findMemberRow(email)` + `findRowMenuButton(row)` + `findRowRoleDropdown(row, role)` — DOM finders dùng bởi nhiều action |

## Code structure pattern

Mọi folder action follow cùng pattern:

```
<action>/
├── README.md                    # Logic + flow + history + debug (file BẮT BUỘC)
├── index.ts                     # Barrel — chỉ re-export public API
├── execute-<action>.ts          # Entry point (nhận từ dispatcher)
├── <helper>.ts                  # Các helper riêng
├── finders/                     # (nếu cần) — DOM finder dedicated
│   └── find-<element>.ts
├── modal1/ modal2/ pages/       # (nếu phức tạp) — split theo concern
│   └── <sub-helper>.ts
└── <other-concern>/             # (vd revoke-probe/, row-extractors/, invoice/)
    └── ...
```

**Quy tắc:**
- **Mỗi hàm public 1 file.** Helper private chỉ 1 caller → gộp vào file của caller.
- **Regex/constant gắn liền hàm** → ở cùng file.
- **JSDoc copy nguyên si** khi rename/refactor để giữ context lịch sử (v0.6.4 vì sao bỏ `scrapedStatuses`, v0.6.6 vì sao force OFF, ...).
- **Barrel `index.ts`** mỗi folder chỉ re-export public API — để dispatcher [`../index.ts`](../index.ts) import path ngắn.

## Dispatcher

[`../index.ts`](../index.ts) chứa `dispatch(msg)` — `switch (msg.kind)` route mỗi
`ExecuteActionRequest` tới 1 action entry. Nếu thêm action mới:
1. Tạo folder + README + index.ts + execute-<x>.ts theo pattern trên.
2. Thêm message kind vào [`../../shared/messages.ts`](../../shared/messages.ts) `ExecuteActionRequest`.
3. Thêm case vào dispatcher.
4. Thêm entry vào bảng "9 actions" trong file này.

## Lịch sử refactor

Folder structure hiện tại đến từ branch `refactor/extension-actions-split` (Pha 0-7, ext v0.6.12 → v0.6.13). Trước đó actions là 10 file flat trong `actions/` (`invite.ts` 802 dòng, `purchase-seat.ts` 894 dòng, ...). Xem chi tiết kế hoạch ở `docs/Extension_Refactor/Plan_Split_Actions_Per_File.md` (local-only, không track).
