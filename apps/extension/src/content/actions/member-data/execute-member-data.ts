import type { ExecuteActionResponse } from "../../../shared/messages";
import {
  humanClick,
  normalizeMatchText,
  querySelectorFirst,
  randomDelay,
  sleep,
  waitFor,
} from "../../human";
import { reportProgress } from "../../progress";
import { SELECTORS, TEXT_FALLBACKS } from "../../selectors";
import { findRowMenuButton } from "../member-row";
import { clickTabAndWait } from "../sync";
import { clearMemberFilter, filterOnceAndResolve } from "../remove/member-filter";
import {
  isDataTextOfKind,
  pickDataMenuItemIndex,
  type DataMenuKind,
} from "../menu-guard";

const LOG = "[autogpt-member-data]";

/**
 * Nhãn nút XÁC NHẬN trong dialog của từng thao tác. Nhãn RIÊNG của thao tác đứng
 * trước nhãn chung ("Xác nhận"/"Confirm") để không vơ nhầm nút khác.
 */
const CONFIRM_TEXTS: Record<DataMenuKind, readonly string[]> = {
  export: [
    "Xuất dữ liệu",
    "Xuất",
    "Export data",
    "Export",
    "Xác nhận",
    "Confirm",
    "导出数据",
    "导出",
    "确认",
  ],
  delete: [
    "Xoá dữ liệu",
    "Xóa dữ liệu",
    "Delete data",
    "Xoá",
    "Xóa",
    "Delete",
    "Xác nhận",
    "Confirm",
    "删除数据",
    "删除",
    "确认",
  ],
};

/**
 * Nút KHÔNG được bấm trong dialog. `startsWith` của `findConfirmButton` có thể
 * dính "Huỷ bỏ" nếu nhãn xác nhận trống/lạ → chặn tường minh.
 */
const CANCEL_TEXTS = [
  "Huỷ bỏ",
  "Hủy bỏ",
  "Huỷ",
  "Hủy",
  "Quay lại",
  "Đóng",
  "Cancel",
  "Back",
  "Close",
  "取消",
  "返回",
  "关闭",
];

/** Mọi item trong menu "..." đang mở (quét rộng role như execute-remove). */
function openMenuItems(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="menu"] [role="menuitem"], [role="menu"] [role="menuitemradio"], ' +
        '[role="menu"] [role="option"], [role="menu"] button, ' +
        '[role="menuitem"], [role="menuitemradio"], [role="option"]',
    ),
  );
}

function dumpMenuItems(): string[] {
  return openMenuItems()
    .map((e) => (e.textContent ?? "").trim())
    .filter(Boolean);
}

function openDialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[role="alertdialog"], [role="dialog"]',
  );
}

/** Tiêu đề dialog đang mở (heading, fallback dòng text đầu). */
function openDialogTitle(): string {
  const d = openDialog();
  if (!d) return "";
  const heading = d.querySelector<HTMLElement>(
    'h1, h2, h3, [role="heading"], [data-testid*="title" i]',
  );
  const raw = heading?.textContent ?? d.textContent ?? "";
  return raw.trim().split("\n")[0]?.trim() ?? "";
}

function isCancelButton(text: string): boolean {
  const hay = normalizeMatchText(text);
  return CANCEL_TEXTS.some((c) => hay === normalizeMatchText(c));
}

/** Nút xác nhận trong dialog theo `kind` — bỏ qua nút huỷ. */
function findConfirmButton(kind: DataMenuKind): HTMLElement | null {
  const dialog = openDialog();
  if (!dialog) return null;
  const btns = Array.from(dialog.querySelectorAll<HTMLElement>("button")).filter(
    (b) => !isCancelButton(b.textContent ?? ""),
  );
  for (const t of CONFIRM_TEXTS[kind]) {
    const needle = normalizeMatchText(t);
    if (!needle) continue;
    for (const b of btns) {
      const hay = normalizeMatchText(b.textContent ?? "");
      if (hay === needle || hay.startsWith(needle)) return b;
    }
  }
  return null;
}

async function escapeDialog(): Promise<void> {
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await sleep(400);
}

function dialogButtons(): string[] {
  const d = openDialog();
  if (!d) return [];
  return Array.from(d.querySelectorAll<HTMLElement>("button"))
    .map((b) => (b.textContent ?? "").trim())
    .filter(Boolean);
}

/**
 * Thực thi "Xuất dữ liệu" / "Xoá dữ liệu" cho 1 member đã tham gia.
 *
 * ⚠️ ĐỌC `README.md` cùng thư mục trước khi sửa. Nguyên tắc xuyên suốt: KHÔNG BAO
 * GIỜ đoán khi DOM lệch — thà FAILED (admin làm tay) còn hơn bấm nhầm một thao
 * tác không hoàn tác.
 */
export async function executeMemberData(
  taskId: string,
  email: string,
  kind: DataMenuKind,
): Promise<ExecuteActionResponse> {
  const what = kind === "export" ? "Xuất dữ liệu" : "Xoá dữ liệu";

  if (!location.pathname.includes("/admin")) {
    return {
      ok: false,
      error_code: "PAGE_NOT_ADMIN",
      error_message: `Trang hiện tại không phải admin (${location.pathname}).`,
    };
  }

  // 2 mục menu này CHỈ có ở tab "Người dùng" (member đã tham gia).
  await reportProgress(
    taskId,
    { phase: "navigating", message: "Chuyển tab Người dùng..." },
    true,
  );
  await clickTabAndWait(
    "tab_active_members",
    TEXT_FALLBACKS.tabActiveMembers,
    800,
    undefined,
    12_000,
  );

  await reportProgress(
    taskId,
    { phase: "searching", message: `Tìm ${email} bằng ô lọc...` },
    true,
  );
  const found = await filterOnceAndResolve(email);
  if (found.outcome !== "found") {
    await clearMemberFilter();
    // KHÔNG có nhánh "absent ⇒ thành công" như REMOVE: ở đây vắng mặt nghĩa là
    // KHÔNG làm được gì cả (không có row để mở menu) → FAILED, member giữ nguyên.
    return {
      ok: false,
      error_code:
        found.outcome === "absent"
          ? "MEMBER_NOT_IN_WORKSPACE"
          : "UI_ELEMENT_NOT_FOUND",
      error_message:
        found.outcome === "absent"
          ? `Không thấy ${email} trong tab "Người dùng" → không thể ${what.toLowerCase()}.`
          : `Ô lọc không chạy (${found.reason}) nên chưa xác định được ${email} → thử lại sau.`,
    };
  }

  const menuBtn = findRowMenuButton(found.row);
  if (!menuBtn) {
    await clearMemberFilter();
    return {
      ok: false,
      error_code: "FAILED_UI_CHANGED",
      error_message: "Không tìm thấy nút menu '...' trong row member.",
    };
  }
  await randomDelay();
  await humanClick(menuBtn);

  // Chọn ĐÚNG mục theo kind — loại trừ chéo với mục dữ liệu còn lại và với
  // "Loại bỏ thành viên" (xem menu-guard.ts). Không khớp → FAILED, không đoán.
  let item: HTMLElement | null = null;
  try {
    item = await waitFor(() => {
      const items = openMenuItems();
      const idx = pickDataMenuItemIndex(
        items.map((e) => e.textContent ?? ""),
        kind,
      );
      return idx >= 0 ? items[idx] : null;
    }, 5000);
  } catch {
    const seen = dumpMenuItems();
    await escapeDialog();
    await clearMemberFilter();
    console.warn(`${LOG} không thấy mục "${what}". Item menu:`, JSON.stringify(seen));
    return {
      ok: false,
      error_code: "FAILED_UI_CHANGED",
      error_message:
        seen.length === 0
          ? `Menu '...' không mở (không thấy item nào) → không ${what.toLowerCase()} được.`
          : `Menu mở nhưng không có mục "${what}". Item thấy: ${JSON.stringify(seen)}`,
    };
  }

  const itemLabel = (item.textContent ?? "").trim();
  console.log(`${LOG} ${email}: click mục "${itemLabel}" (${kind})`);
  await randomDelay();
  await humanClick(item);

  // Sau khi click: chờ MỘT trong hai bằng chứng ChatGPT đã nhận thao tác —
  // dialog xác nhận, hoặc toast thành công (luồng không cần xác nhận).
  await reportProgress(
    taskId,
    { phase: "confirming", message: `Chờ hộp thoại ${what.toLowerCase()}...` },
    true,
  );
  let sawDialog = false;
  try {
    await waitFor(() => {
      if (openDialog()) {
        sawDialog = true;
        return document.body;
      }
      return querySelectorFirst(SELECTORS.inviteSuccessToast);
    }, 6000, 250);
  } catch {
    await clearMemberFilter();
    // Không dialog, không toast → KHÔNG kết luận được là đã làm hay chưa. Với
    // thao tác không hoàn tác, báo FAILED (admin kiểm tra tay) an toàn hơn nhiều
    // so với báo thành công giả.
    return {
      ok: false,
      error_code: "FAILED_UI_CHANGED",
      error_message:
        `Đã bấm "${itemLabel}" nhưng KHÔNG thấy hộp thoại xác nhận lẫn thông báo ` +
        `thành công sau 6s → không xác định được ChatGPT có nhận lệnh không. ` +
        `Kiểm tra thủ công trên ChatGPT.`,
    };
  }

  if (!sawDialog) {
    // Chỉ có toast → ChatGPT thực thi ngay, không cần xác nhận.
    await clearMemberFilter();
    console.log(`${LOG} ${email}: có toast thành công, không cần dialog → COMPLETED`);
    return { ok: true, data: { email, kind, confirmed_via: "toast" } };
  }

  // CHỐT CHẶN: dialog vừa mở phải đúng thao tác đang làm. Sai (vd mở nhầm dialog
  // "Loại bỏ thành viên" hoặc mục dữ liệu kia) → ESC, KHÔNG bấm gì.
  const title = openDialogTitle();
  if (title && !isDataTextOfKind(title, kind)) {
    console.warn(`${LOG} dialog "${title}" KHÔNG khớp thao tác ${kind} → ESC`);
    await escapeDialog();
    await clearMemberFilter();
    return {
      ok: false,
      error_code: "FAILED_UI_CHANGED",
      error_message:
        `Bấm "${itemLabel}" nhưng ChatGPT mở hộp thoại "${title}" — không khớp thao ` +
        `tác "${what}" → đã huỷ, KHÔNG xác nhận. Nhãn menu ChatGPT có thể đã đổi.`,
    };
  }

  const confirmBtn = findConfirmButton(kind);
  if (!confirmBtn) {
    const btns = dialogButtons();
    await escapeDialog();
    await clearMemberFilter();
    return {
      ok: false,
      error_code: "FAILED_UI_CHANGED",
      error_message: `Không tìm thấy nút xác nhận "${what}". Nút trong dialog: ${JSON.stringify(btns)}`,
    };
  }

  await randomDelay();
  await humanClick(confirmBtn);

  // Verify: dialog ĐÓNG = ChatGPT đã nhận lệnh (cùng tín hiệu với REMOVE — xem
  // remove/README.md v0.9.13; đọc lại list vô nghĩa vì backend eventual-consistent
  // và 2 thao tác này không đổi gì trên danh sách member).
  await reportProgress(
    taskId,
    { phase: "verifying", message: "Đợi ChatGPT xác nhận..." },
    true,
  );
  let closed = false;
  try {
    await waitFor(() => (openDialog() ? null : document.body), 15_000, 250);
    closed = true;
  } catch {
    closed = false;
  }
  await clearMemberFilter();

  if (!closed) {
    const d = openDialog();
    const text = (d?.textContent ?? "").trim().slice(0, 200);
    return {
      ok: false,
      error_code: "VERIFY_FAILED",
      error_message:
        `Đã bấm xác nhận "${what}" nhưng hộp thoại KHÔNG đóng sau 15s → ChatGPT có ` +
        `thể yêu cầu OTP/2FA hoặc báo lỗi.` + (text ? ` Dialog: "${text}"` : ""),
    };
  }

  console.log(`${LOG} ${email}: ${kind} — dialog đã đóng → COMPLETED`);
  return { ok: true, data: { email, kind, confirmed_via: "dialog", item: itemLabel } };
}
