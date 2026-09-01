/**
 * CANVA_INVITE — mời email vào team Canva ở `canva.com/settings/people`.
 *
 * Đi ĐÚNG tám bước user mô tả kèm ảnh (2026-09-01):
 *   1. Bấm "Mời thành viên" (banner) HOẶC "+ Mời mọi người" (cuối bảng) — thấy cái
 *      nào bấm cái đó, hai nút cùng mở một hộp.
 *   2. Đọc "Đội của bạn có N người" trong hộp → biết còn bao nhiêu chỗ trong 50 suất.
 *   3. Gõ email vào ô "Nhập địa chỉ email…".
 *   4. Chọn vai trò ở dropdown "Chỉ định vai trò".
 *   5. Nhập xong email thứ nhất thì Canva hiện thêm ô trống → lặp cho email tiếp theo.
 *   6. Bấm "Xác nhận và mời".
 *   7. Hộp "Lời mời đã được gửi!" liệt kê từng email kèm nút "Sao chép liên kết" →
 *      lấy LINK DUY NHẤT của từng email, gắn đúng vào email đó.
 *   8. Bấm "Xong" rồi đọc lại danh sách để XÁC MINH email đã thành dòng "Đã mời".
 *
 * KHÔNG bấm hàng loạt rồi đoán thứ tự link: mỗi liên kết chỉ dùng được cho đúng một
 * email, gán nhầm là khách bấm vào link của người khác. Bấm từng dòng, chờ bắt được
 * chuỗi vừa chép rồi mới sang dòng sau (xem `clipboard-capture.ts`).
 *
 * PHÍ ĐÃ TRỪ TRƯỚC KHI CHẠY: email nào không xác minh được ở bước 8 phải trả về
 * `unverified_emails` để backend hoàn phí — im lặng coi như thành công là ăn tiền
 * của đại lý cho một lời mời không tồn tại.
 */

import type { CanvaActionRequest, CanvaActionResponse, CanvaRole } from "../../shared/messages";
import { humanClick, humanType, sleep } from "../human";
import { reportProgress } from "../progress";
import {
  clickableByAnyText,
  emailIn,
  emptyEmailInputs,
  norm,
  numberIn,
  onPeoplePage,
  openDialog,
  visible,
  waitUntil,
} from "./dom";
import {
  installCopyCapture,
  resetCopyCapture,
  waitForCopiedText,
} from "./clipboard-capture";
import { scrapePeopleTable } from "./sync";

// Chữ trên trang, CẢ HAI ngôn ngữ. Team của user đang để tiếng Anh (ảnh 2026-09-01)
// nhưng tài khoản khác có thể đang tiếng Việt, nên mọi chỗ đều nhận cả hai. So sánh
// đã bỏ dấu + bỏ hoa thường (xem `dom.norm`), và là so CHỨA chứ không so bằng.
const OPEN_INVITE_TEXTS = [
  "Mời thành viên",
  "Mời mọi người",
  "Invite people",
  "Invite members",
];
const SUBMIT_TEXTS = ["Xác nhận và mời", "Confirm and invite", "Gửi lời mời", "Send invites"];
const DONE_TEXTS = ["Xong", "Done"];
// "Copy unique link" KHÔNG chứa chuỗi "copy link" — phải liệt kê riêng, thiếu là mất
// sạch liên kết mời ở bản tiếng Anh.
const COPY_LINK_TEXTS = [
  "Sao chép liên kết duy nhất",
  "Sao chép liên kết",
  "Copy unique link",
  "Copy link",
];

/** Chữ trong menu vai trò ứng với từng vai trò dashboard cho chọn. */
const ROLE_TEXTS: Record<CanvaRole, string[]> = {
  member: ["Thành viên đội", "Team member"],
  brand_designer: ["Nhà thiết kế thương hiệu của đội", "Brand designer"],
};

/** Hộp mời đang mở? Nhận bằng CẤU TRÚC (có ô email trống) chứ không bằng tiêu đề —
 *  tiêu đề đổi theo ngôn ngữ, ô nhập thì không. */
function inviteDialogOpen(): HTMLElement | null {
  const dlg = openDialog();
  return dlg && emptyEmailInputs(dlg).length > 0 ? dlg : null;
}

function fail(
  code: Extract<CanvaActionResponse, { ok: false }>["error_code"],
  message: string,
  data?: Record<string, unknown>,
): CanvaActionResponse {
  return { ok: false, error_code: code, error_message: message, data };
}

/**
 * Mở hộp "Mời mọi người vào đội". Trả hộp đang mở, null nếu không mở được.
 *
 * PHẢI CHỜ nút hiện ra chứ không tìm một phát rồi bỏ cuộc. Content script nạp ở
 * `document_idle` nên trả lời PING xong từ rất lâu trước khi ứng dụng React của
 * Canva vẽ xong bảng thành viên. Ca thật 31/8/2026 (lệnh 3effabd4): lệnh chết
 * UI_ELEMENT_NOT_FOUND đúng 1,1 giây sau khi nhận — lúc đó trang chưa vẽ nút nào.
 */
async function openInviteDialog(): Promise<HTMLElement | null> {
  const existing = inviteDialogOpen();
  if (existing) return existing;
  const opener = await waitUntil(() => clickableByAnyText(OPEN_INVITE_TEXTS), 25000);
  if (!opener) return null;
  await humanClick(opener);
  return waitUntil(inviteDialogOpen, 15000);
}

/** Nhãn mọi nút đang hiện — đính vào thông báo lỗi để biết Canva đã đổi chữ thành gì.
 *
 * Không có nó thì mỗi lần Canva đổi nhãn nút, lệnh chỉ báo "không thấy nút" và phải
 * ngồi đoán; có nó là đọc nhật ký ra ngay chữ mới để bổ sung vào OPEN_INVITE_TEXTS. */
function visibleButtonLabels(): string[] {
  const labels = new Set<string>();
  for (const el of document.querySelectorAll<HTMLElement>('button, [role="button"]')) {
    if (labels.size >= 25) break;
    if (!visible(el)) continue;
    const label = (el.textContent ?? "").trim().replace(/\s+/g, " ");
    if (label && label.length <= 40) labels.add(label);
  }
  return [...labels];
}

/** "Đội của bạn có N người." / "Your team has N people." → N.
 *
 * SỐ NÀY KỂ CẢ LỜI MỜI ĐANG CHỜ, khác tiêu đề trang. Đối chiếu ảnh user 2026-09-01:
 * tiêu đề "People (2)" (2 người đã vào) trong khi hộp mời nói "Your team has 5
 * people" — vì đội còn 3 lời mời treo. Tức đây mới là số CHIẾM CHỖ trong 50 suất của
 * gói, và nó khớp đúng cách dashboard đếm (active + pending). Đừng thay bằng số ở
 * tiêu đề: làm thế là tưởng còn trống 48 chỗ trong khi thực tế chỉ còn 45.
 */
const TEAM_SIZE_MARKS = ["doi cua ban co", "your team has"];

function teamSizeIn(dialog: HTMLElement): number | null {
  const line = [...dialog.querySelectorAll<HTMLElement>("*")]
    .filter(visible)
    .map((el) => el.textContent ?? "")
    .find((t) => TEAM_SIZE_MARKS.some((m) => norm(t).includes(m)));
  return line ? numberIn(line) : null;
}

/** Đặt vai trò cho hàng nhập thứ `index` (0-based). Không có menu → bỏ qua. */
async function pickRole(dialog: HTMLElement, index: number, role: CanvaRole): Promise<void> {
  // Mặc định của Canva đã là "Thành viên đội" → khỏi mở menu cho nhanh và bớt rủi ro.
  if (role === "member") return;
  const triggers = [...dialog.querySelectorAll<HTMLElement>('button, [role="combobox"]')].filter(
    (el) => visible(el) && ROLE_TEXTS.member.some((t) => norm(el.textContent).includes(norm(t))),
  );
  const trigger = triggers[index] ?? triggers[triggers.length - 1];
  if (!trigger) return;
  await humanClick(trigger);
  const option = await waitUntil(
    () => clickableByAnyText(ROLE_TEXTS[role]),
    6000,
  );
  if (option) await humanClick(option);
}

/**
 * Lấy liên kết duy nhất cho từng email trong hộp "Lời mời đã được gửi!".
 *
 * Best-effort: thiếu link KHÔNG làm hỏng lệnh mời đã gửi thành công — chỉ là đại lý
 * phải vào Canva copy tay. Đừng đánh đổi một lệnh mời đã trả tiền lấy một cái link.
 */
async function collectInviteLinks(
  dialog: HTMLElement,
  step: (phase: string, message: string) => Promise<void>,
): Promise<Record<string, string>> {
  const links: Record<string, string> = {};
  const buttons = [...dialog.querySelectorAll<HTMLElement>("button, [role='button']")].filter(
    (el) => visible(el) && COPY_LINK_TEXTS.some((t) => norm(el.textContent).includes(norm(t))),
  );
  for (const btn of buttons) {
    // Email của DÒNG chứa nút này — không lấy email đầu hộp, mỗi dòng một người.
    let row: HTMLElement | null = btn;
    let email: string | null = null;
    for (let up = 0; up < 6 && row; up += 1) {
      email = emailIn(row.textContent);
      if (email) break;
      row = row.parentElement;
    }
    if (!email) continue;
    resetCopyCapture();
    await humanClick(btn);
    const copied = await waitForCopiedText(4000);
    if (copied && /^https?:\/\//i.test(copied)) links[email] = copied;
    await step("copy_links", `Đã lấy liên kết cho ${Object.keys(links).length} email`);
    await sleep(150);
  }
  return links;
}

export async function executeCanvaInvite(
  msg: Extract<CanvaActionRequest, { kind: "CANVA_INVITE" }>,
): Promise<CanvaActionResponse> {
  if (!onPeoplePage()) {
    return fail("PAGE_NOT_PEOPLE", `Không ở trang thành viên Canva (đang ở ${location.href}).`);
  }
  const entries = msg.entries.filter((e) => e.email.trim());
  if (entries.length === 0) {
    return fail("UNKNOWN", "Lệnh mời không có email nào.");
  }

  installCopyCapture();

  // BÁO TIẾN ĐỘ Ở TỪNG CHẶNG — không chỉ để nhìn cho vui. Mỗi tin nhắn gửi về
  // background là một lần chạm vào service worker, giữ nó khỏi bị Chrome cho ngủ
  // giữa lượt gọi dài. Thiếu nhịp này thì lệnh mời Canva chạy xong mà KHÔNG AI BÁO:
  // service worker chết, backend đợi đủ 8 phút rồi tự đánh hỏng (ca thật
  // wiliamdio@ 2026-09-01, y hệt lỗi nhánh ChatGPT đã chữa 26/8).
  const step = (phase: string, message: string) =>
    reportProgress(msg.taskId, { phase, message }, true);

  await step("open_dialog", "Đang mở hộp mời trên Canva…");
  const dialog = await openInviteDialog();
  if (!dialog) {
    const labels = visibleButtonLabels();
    return fail(
      "UI_ELEMENT_NOT_FOUND",
      'Không mở được hộp mời (không thấy nút "Mời thành viên" / "Mời mọi người"). ' +
        `Nút đang hiện: ${labels.length ? labels.join(" | ") : "(trang không có nút nào)"}.`,
      { visible_buttons: labels },
    );
  }

  const teamSize = teamSizeIn(dialog);
  await step("dialog_open", `Đã mở hộp mời${teamSize ? ` (đội đang có ${teamSize} người)` : ""}`);

  // Nhập từng email: gõ xong ô này Canva mới hiện ô trống kế tiếp.
  for (let i = 0; i < entries.length; i += 1) {
    const input = await waitUntil(() => emptyEmailInputs(dialog)[0] ?? null, 8000);
    if (!input) {
      return fail(
        "UI_ELEMENT_NOT_FOUND",
        `Không thấy ô nhập email cho địa chỉ thứ ${i + 1} (${entries[i].email}).`,
      );
    }
    await humanType(input, entries[i].email);
    await pickRole(dialog, i, entries[i].role);
    await step("typing", `Đã nhập ${i + 1}/${entries.length} email`);
    await sleep(200);
  }

  const submit = await waitUntil(() => {
    const btn = clickableByAnyText(SUBMIT_TEXTS, dialog);
    return btn && !(btn as HTMLButtonElement).disabled ? btn : null;
  }, 8000);
  if (!submit) {
    return fail("UI_ELEMENT_NOT_FOUND", 'Không bấm được nút "Xác nhận và mời".');
  }
  await humanClick(submit);
  await step("submitted", "Đã bấm gửi, đang chờ Canva xác nhận…");

  // Hộp kết quả: "Lời mời đã được gửi!…" — cũng là chỗ lấy liên kết duy nhất.
  // "Lời mời đã được gửi! …liên kết duy nhất" / "Invite sent! Follow up with a unique
  // link?" — nhận theo chữ đặc trưng của CẢ HAI bản, hoặc theo chính nút sao chép.
  const SENT_MARKS = [
    "loi moi da duoc gui",
    "lien ket moi",
    "invite sent",
    "unique link",
  ];
  const sentDialog = await waitUntil(() => {
    const dlg = openDialog();
    if (!dlg) return null;
    const t = norm(dlg.textContent);
    if (SENT_MARKS.some((m) => t.includes(m))) return dlg;
    return COPY_LINK_TEXTS.some((c) => t.includes(norm(c))) ? dlg : null;
  }, 20000);

  let inviteLinks: Record<string, string> = {};
  if (sentDialog) {
    await step("copy_links", "Đang lấy liên kết mời của từng email…");
    inviteLinks = await collectInviteLinks(sentDialog, step);
    const done = clickableByAnyText(DONE_TEXTS, sentDialog);
    if (done) await humanClick(done);
  }

  // XÁC MINH ở danh sách: email phải thành dòng "Đã mời" (hoặc đã là thành viên).
  await step("verify", "Đang đọc lại danh sách để xác minh…");
  const wanted = entries.map((e) => e.email.toLowerCase());
  const seen = await waitUntil(() => {
    const rows = scrapePeopleTable();
    const found = new Set(rows.map((r) => r.email));
    return wanted.every((e) => found.has(e)) ? found : null;
  }, 20000);

  const found = seen ?? new Set(scrapePeopleTable().map((r) => r.email));
  const invited = wanted.filter((e) => found.has(e));
  const unverified = wanted.filter((e) => !found.has(e));

  if (invited.length === 0) {
    return fail(
      "VERIFY_FAILED",
      "Đã bấm mời nhưng không thấy email nào xuất hiện trong danh sách Canva.",
      { unverified_emails: unverified, team_size: teamSize },
    );
  }

  return {
    ok: true,
    data: {
      invited_emails: invited,
      unverified_emails: unverified,
      invite_links: inviteLinks,
      team_size: teamSize,
    },
  };
}
