import { humanClick, sleep } from "../../human";
import { findExternalInvitesToggle } from "./finders/find-toggle";
import { navigateTo } from "./navigate";

const IDENTITY_PATH = "/admin/identity";

/**
 * Đọc state toggle. Trả `null` khi KHÔNG xác định được (không đoán bừa) —
 * caller phải phân biệt "OFF" với "không đọc được", tránh quyết định sai
 * (vd tưởng đã ON rồi bỏ qua click → mời email ngoài khi toggle thật OFF).
 */
function getToggleState(el: HTMLElement): boolean | null {
  if (el.tagName === "INPUT") {
    return (el as HTMLInputElement).checked;
  }
  // button[role="switch"]: aria-checked="true" | "false"
  const aria = el.getAttribute("aria-checked");
  if (aria === "true") return true;
  if (aria === "false") return false;
  // Fallback: data-state="checked" (Radix UI)
  const ds = el.getAttribute("data-state");
  if (ds === "checked") return true;
  if (ds === "unchecked") return false;
  console.warn(
    "[autogpt-external-invites] KHÔNG đọc được state toggle (thiếu aria-checked/data-state/.checked) → trả null (unknown)",
  );
  return null;
}

/** Tìm lại toggle trên DOM hiện tại + đọc state. null nếu mất toggle hoặc không rõ. */
function readStateFresh(): boolean | null {
  const el = findExternalInvitesToggle();
  if (!el) return null;
  return getToggleState(el);
}

/**
 * Poll `getToggleState` tới khi == target (ChatGPT lưu PATCH bất đồng bộ,
 * DOM có thể phản ánh chậm). Trả true ngay khi xác nhận, false nếu hết hạn.
 */
async function pollUntilState(
  target: boolean,
  timeoutMs: number,
  stepMs = 400,
): Promise<boolean> {
  const ticks = Math.max(1, Math.ceil(timeoutMs / stepMs));
  for (let i = 0; i < ticks; i++) {
    await sleep(stepMs);
    if (readStateFresh() === target) return true;
  }
  return false;
}

/**
 * Set toggle về `target`. Trả về:
 *   - prev: state trước khi đổi (true|false), hoặc null nếu không tìm thấy
 *     toggle / không đọc được state.
 *   - changed: boolean — có thực sự click hay không.
 *   - confirmed: boolean — trạng thái CUỐI đã được XÁC NHẬN = `target`. Caller
 *     dùng cờ này để quyết định có an toàn invite hay không (vd email ngoài
 *     domain BẮT BUỘC confirmed=true mới được mời).
 *
 * Độ tin cậy (v0.8.10): thay vì click 1 lần + sleep cứng + đọc 1 lần, hàm:
 *   1. Nếu tưởng đã ở `target` → đọc lại lần 2 (double-check) để loại trừ
 *      đọc nhầm transient/bắt nhầm switch trước khi quyết định SKIP.
 *   2. Khi click → POLL state tới khi == target (chờ ChatGPT lưu), không
 *      dựa vào sleep cố định → hết "confirmed=false oan" do mạng/PATCH chậm.
 *   3. Retry click tối đa 2 lần nếu lần đầu chưa ăn.
 */
export async function setExternalInvites(
  target: boolean,
): Promise<{ prev: boolean | null; changed: boolean; confirmed: boolean }> {
  const ok = await navigateTo(IDENTITY_PATH, () => !!findExternalInvitesToggle());
  if (!ok) {
    return { prev: null, changed: false, confirmed: false };
  }
  const toggle = findExternalInvitesToggle();
  if (!toggle) return { prev: null, changed: false, confirmed: false };

  const prev = getToggleState(toggle);

  // Đã có vẻ ở đúng trạng thái → double-check 1 nhịp trước khi SKIP. Quan trọng
  // với target=ON: nếu thật ra OFF mà ta bỏ qua → mời email ngoài khi toggle tắt
  // → ChatGPT từ chối silently → phantom "đang chờ" trên dashboard.
  if (prev === target) {
    await sleep(250);
    const recheck = readStateFresh();
    if (recheck === target) {
      console.log(
        `[autogpt-external-invites] toggle đã ở ${target} (xác nhận 2 lần) → skip click`,
      );
      return { prev, changed: false, confirmed: true };
    }
    console.warn(
      `[autogpt-external-invites] đọc lại lệch (lần1=${prev}, lần2=${recheck}) → click cho chắc`,
    );
  }

  // Click + poll xác nhận, retry tối đa 2 lần.
  let confirmed = false;
  for (let attempt = 0; attempt < 2 && !confirmed; attempt++) {
    const el = findExternalInvitesToggle();
    if (!el) break;
    const cur = getToggleState(el);
    if (cur === target) {
      confirmed = true;
      break;
    }
    console.log(
      `[autogpt-external-invites] click toggle (lần ${attempt + 1}): ${cur} → ${target}`,
    );
    await humanClick(el);
    // Chờ ChatGPT fire PATCH /api/... + DOM phản ánh. Poll tới 4s thay vì sleep cứng.
    confirmed = await pollUntilState(target, 4_000);
  }

  if (confirmed) {
    console.log(`[autogpt-external-invites] OK, toggle = ${target} (confirmed)`);
  } else {
    console.warn(
      `[autogpt-external-invites] KHÔNG xác nhận được toggle = ${target} sau retry — caller nên huỷ invite (tránh phantom)`,
    );
  }

  return { prev, changed: true, confirmed };
}
