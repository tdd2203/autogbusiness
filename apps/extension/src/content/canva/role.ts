/**
 * CANVA_CHANGE_ROLE — đổi vai trò một người trong team Canva.
 *
 * LỐI CHÍNH (user mô tả kèm ảnh 2026-09-01): tick ô vuông đầu dòng → thanh thao tác ở
 * đáy trang → nút "Change roles" → bảng chọn hiện ra ba mục, mỗi mục một tiêu đề đậm
 * kèm một đoạn mô tả:
 *
 *   Team admin            Can manage your team members, create design templates…
 *   Team brand designer   Can create design templates for your brand…
 *   Team member           Can create and share designs…
 *
 * CHỈ ĐƯỢC ĐẶT "Team member" HOẶC "Team brand designer" (user chốt). Xin vai trò khác
 * thì DỪNG, không hạ xuống member cho xong — tự ý đặt sai quyền còn tệ hơn báo lỗi.
 *
 * ⚠️ PHẢI SO TIÊU ĐỀ, KHÔNG SO CẢ KHỐI. Mô tả của mục "Team admin" chứa nguyên chữ
 * "your team members" → so kiểu "khối nào chứa chữ 'team member'" sẽ chọn trúng mục
 * ADMIN khi đang định đặt member, mà mục admin lại còn NGẮN HƠN nên kiểu "lấy khối
 * nhỏ nhất" cũng trượt nốt. Thăng nhầm quyền quản trị cho khách là lỗi im lặng:
 * dashboard vẫn báo đổi vai trò thành công.
 */

import type {
  CanvaActionRequest,
  CanvaActionResponse,
  CanvaRole,
} from "../../shared/messages";
import { humanClick } from "../human";
import { reportProgress } from "../progress";
import { norm, onPeoplePage, visible, waitUntil } from "./dom";
import { bulkBarButton, rowOf, selectRowAlone, untick } from "./selection";

/** Nhãn nút "Change roles" trên thanh thao tác. */
const BULK_ROLE_MARKS = ["change role", "doi vai tro"];

/** Ba nút CÒN LẠI trên thanh — chặn cứng, tuyệt đối không nhận nhầm. */
const BULK_OTHER_MARKS = [
  "remove user",
  "xoa nguoi dung",
  "go nguoi dung",
  "resend invite",
  "gui lai loi moi",
  "add to group",
  "them vao nhom",
];

/** Tiêu đề mục vai trò trong bảng chọn, theo từng vai trò dashboard cho phép. */
const ROLE_TITLES: Record<CanvaRole, string[]> = {
  member: ["Team member", "Thành viên đội"],
  brand_designer: [
    "Team brand designer",
    "Nhà thiết kế thương hiệu của đội",
    "Brand designer",
  ],
};

/** Tiêu đề KHÔNG BAO GIỜ được bấm, dù khớp kiểu gì. */
const FORBIDDEN_TITLES = [
  "Team admin",
  "Team owner",
  "Quản trị viên đội",
  "Chủ sở hữu đội",
];

/**
 * Tiêu đề của một mục = DÒNG ĐẦU của khối, không phải cả khối.
 *
 * Dùng `innerText` chứ không `textContent`: `textContent` dán tiêu đề liền vào mô tả
 * ("Team adminCan manage your team members…") nên không cắt được dòng đầu.
 */
function optionTitle(el: HTMLElement): string {
  const raw = el.innerText || el.textContent || "";
  const first = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return norm(first ?? "");
}

/** Mục vai trò cần bấm trong bảng chọn — so BẰNG, không so chứa. */
function roleOption(role: CanvaRole): HTMLElement | null {
  const wanted = ROLE_TITLES[role].map(norm);
  const forbidden = FORBIDDEN_TITLES.map(norm);
  const found = [
    ...document.querySelectorAll<HTMLElement>(
      'button, [role="menuitem"], [role="menuitemradio"], [role="option"], [role="radio"], li, a, div, span, p',
    ),
  ].filter((el) => {
    const title = optionTitle(el);
    if (forbidden.includes(title)) return false;
    return wanted.includes(title) && visible(el);
  });
  if (found.length === 0) return null;
  // Khối NHỎ NHẤT khớp = chính dòng tiêu đề. Bấm vào đó, sự kiện nổi lên tới ô chọn.
  return found.sort((a, b) => (a.textContent?.length ?? 0) - (b.textContent?.length ?? 0))[0];
}

/** Vai trò hiện đang hiển thị ở dòng đó (đọc để xác minh sau khi đổi). */
function roleShownIn(row: HTMLElement): CanvaRole | "admin" | "owner" | null {
  const t = norm(row.textContent);
  if (t.includes("chu so huu") || t.includes("team owner")) return "owner";
  if (t.includes("quan tri vien") || t.includes("team admin")) return "admin";
  if (t.includes("thiet ke thuong hieu") || t.includes("brand designer")) return "brand_designer";
  if (t.includes("thanh vien doi") || t.includes("team member")) return "member";
  return null;
}

export async function executeCanvaChangeRole(
  msg: Extract<CanvaActionRequest, { kind: "CANVA_CHANGE_ROLE" }>,
): Promise<CanvaActionResponse> {
  if (!onPeoplePage()) {
    return {
      ok: false,
      error_code: "PAGE_NOT_PEOPLE",
      error_message: `Không ở trang thành viên Canva (đang ở ${location.href}).`,
    };
  }
  const email = msg.email.toLowerCase();
  await reportProgress(
    msg.taskId,
    { phase: "changing_role", message: `Đang đặt vai trò cho ${email}` },
    true,
  );

  const row = rowOf(email);
  if (!row) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message: `Không thấy ${email} trong bảng thành viên Canva.`,
    };
  }
  if (roleShownIn(row) === msg.role) {
    // Đã đúng vai trò rồi — đụng vào chỉ tạo thêm rủi ro.
    return { ok: true, data: { email, canva_role: msg.role, already: true } };
  }

  const picked = await selectRowAlone(row);
  if (!picked.ok) {
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message: `Không chọn được đúng một dòng cho ${email} (${picked.reason}).`,
    };
  }

  const roleBtn = bulkBarButton(BULK_ROLE_MARKS, BULK_OTHER_MARKS);
  if (!roleBtn) {
    await untick(picked.checkbox);
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message: 'Không thấy nút "Change roles" trên thanh thao tác Canva.',
    };
  }
  await humanClick(roleBtn);

  const option = await waitUntil(() => roleOption(msg.role), 8000);
  if (!option) {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await untick(picked.checkbox);
    return {
      ok: false,
      error_code: "UI_ELEMENT_NOT_FOUND",
      error_message: `Không thấy mục vai trò "${ROLE_TITLES[msg.role][0]}" trong bảng chọn Canva.`,
    };
  }
  await humanClick(option);

  // Xác minh trên chính dòng đó: cột vai trò phải đổi sang giá trị mới.
  const done = await waitUntil(() => {
    const fresh = rowOf(email);
    return fresh && roleShownIn(fresh) === msg.role ? true : null;
  }, 15000);

  await untick(picked.checkbox);

  if (!done) {
    return {
      ok: false,
      error_code: "VERIFY_FAILED",
      error_message: `Đã bấm đặt vai trò cho ${email} nhưng cột vai trò trên trang Canva chưa đổi.`,
      data: { email, wanted_role: msg.role },
    };
  }
  return { ok: true, data: { email, canva_role: msg.role } };
}
