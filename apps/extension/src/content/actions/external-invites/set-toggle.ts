import { humanClick, sleep } from "../../human";
import { findExternalToggleToast } from "./detect-toggle-toast";
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
 *
 * @param onTick chạy mỗi nhịp — dùng để ngó câu xác nhận ChatGPT in ra, vốn
 *   chỉ hiện vài giây rồi tự tắt.
 */
async function pollUntilState(
  target: boolean,
  timeoutMs: number,
  onTick?: () => void,
  stepMs = 400,
): Promise<boolean> {
  const ticks = Math.max(1, Math.ceil(timeoutMs / stepMs));
  for (let i = 0; i < ticks; i++) {
    await sleep(stepMs);
    onTick?.();
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
 *   - toast: câu ChatGPT tự in ra sau khi lưu ("Lời mời từ miền bên ngoài bị vô
 *     hiệu hóa với không gian làm việc này" — user 30/8/2026), null nếu không
 *     bắt được. Nó tự tắt sau vài giây nên KHÔNG bắt được không nói lên điều gì.
 *   - confirmedBy: `"dom"` khi cờ confirmed dựng từ công tắc, `"toast"` khi
 *     dựng từ câu trên (chỉ xảy ra ở chiều TẮT — xem dưới), null khi chưa xác
 *     nhận được.
 *
 * Độ tin cậy (v0.8.10): thay vì click 1 lần + sleep cứng + đọc 1 lần, hàm:
 *   1. Nếu tưởng đã ở `target` → đọc lại lần 2 (double-check) để loại trừ
 *      đọc nhầm transient/bắt nhầm switch trước khi quyết định SKIP.
 *   2. Khi click → POLL state tới khi == target (chờ ChatGPT lưu), không
 *      dựa vào sleep cố định → hết "confirmed=false oan" do mạng/PATCH chậm.
 *   3. Retry click tối đa 2 lần nếu lần đầu chưa ăn.
 */
export async function setExternalInvites(target: boolean): Promise<{
  prev: boolean | null;
  changed: boolean;
  confirmed: boolean;
  toast: string | null;
  confirmedBy: "dom" | "toast" | null;
}> {
  const ok = await navigateTo(IDENTITY_PATH, () => !!findExternalInvitesToggle());
  if (!ok) {
    return {
      prev: null,
      changed: false,
      confirmed: false,
      toast: null,
      confirmedBy: null,
    };
  }
  const toggle = findExternalInvitesToggle();
  if (!toggle) {
    return {
      prev: null,
      changed: false,
      confirmed: false,
      toast: null,
      confirmedBy: null,
    };
  }

  const prev = getToggleState(toggle);

  /**
   * Câu ChatGPT in ra khi đã LƯU XONG trạng thái mới. Giữ lần thấy đầu tiên: nó
   * chỉ nói một điều và điều đó không đảo ngược. Chỉ nhận câu khai ĐÚNG chiều
   * ta đang đặt — câu của chiều ngược lại là tàn dư của cú bấm trước.
   */
  let toast: string | null = null;
  const captureToast = (): void => {
    if (toast !== null) return;
    const seen = findExternalToggleToast();
    if (!seen || seen.enabled !== target) return;
    toast = seen.text;
    console.log(
      `[autogpt-external-invites] ChatGPT xác nhận bằng câu: "${seen.text}"`,
    );
  };
  captureToast();

  // Đã có vẻ ở đúng trạng thái → double-check 1 nhịp trước khi SKIP. Quan trọng
  // với target=ON: nếu thật ra OFF mà ta bỏ qua → mời email ngoài khi toggle tắt
  // → ChatGPT từ chối silently → phantom "đang chờ" trên dashboard.
  if (prev === target) {
    await sleep(600);
    captureToast();
    const recheck = readStateFresh();
    if (recheck === target) {
      console.log(
        `[autogpt-external-invites] toggle đã ở ${target} (xác nhận 2 lần) → skip click`,
      );
      // Dù đã ON sẵn (prev), vẫn để server chốt trước khi caller HARD-RELOAD
      // refetch org-config (xem settleServerCommit bên dưới).
      await settleServerCommit(target);
      captureToast();
      return { prev, changed: false, confirmed: true, toast, confirmedBy: "dom" };
    }
    console.warn(
      `[autogpt-external-invites] đọc lại lệch (lần1=${prev}, lần2=${recheck}) → click cho chắc`,
    );
  }

  // Click + poll xác nhận, retry tối đa 3 lần (v0.8.x "làm chậm mà chắc": tăng
  // 2→3 + poll 4s→6s để mạng/PATCH chậm không rơi confirmed=false oan).
  let confirmed = false;
  for (let attempt = 0; attempt < 3 && !confirmed; attempt++) {
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
    // Chờ ChatGPT fire PATCH /api/... + DOM phản ánh. Poll tới 6s thay vì sleep cứng.
    confirmed = await pollUntilState(target, 6_000, captureToast);
  }

  let confirmedBy: "dom" | "toast" | null = confirmed ? "dom" : null;

  if (confirmed) {
    console.log(`[autogpt-external-invites] OK, toggle = ${target} (confirmed)`);
    await settleServerCommit(target);
    captureToast();
  } else if (target === false && toast !== null) {
    // Công tắc đọc không ra (mất khỏi DOM sau re-render, hoặc thiếu
    // aria-checked) NHƯNG ChatGPT vừa nói thẳng là đã tắt. Lời của ChatGPT chắc
    // hơn phép đọc của ta: nó chỉ in sau khi lưu xong.
    //
    // CHỈ áp cho chiều TẮT — đó là bước DỌN sau khi mời, kết luận sai chỉ tốn
    // một dòng cảnh báo. Chiều BẬT thì `confirmed` là điều kiện để mời email
    // ngoài miền: ở đó vẫn phải tự đọc công tắc, vì nhận nhầm là mời mù vào một
    // workspace đang chặn, tức lời mời chết im và dashboard treo "đang chờ".
    confirmed = true;
    confirmedBy = "toast";
    console.log(
      `[autogpt-external-invites] không đọc được công tắc nhưng ChatGPT báo: "${toast}" → coi như đã tắt`,
    );
  } else {
    console.warn(
      `[autogpt-external-invites] KHÔNG xác nhận được toggle = ${target} sau retry — caller nên huỷ invite (tránh phantom)`,
    );
  }

  return { prev, changed: true, confirmed, toast, confirmedBy };
}

/**
 * "Làm chậm mà chắc" (fix 2026-07-15): DOM toggle `aria-checked=true` chỉ nghĩa
 * là client ĐÃ FIRE PATCH lưu setting — KHÔNG đảm bảo ChatGPT đã COMMIT server-side.
 * Ngay sau đó `execute-invite.ts` (Phase A) trả `awaiting_external_reload` →
 * background HARD-RELOAD /admin/members để REFETCH org-config. Nếu reload chạy
 * TRƯỚC khi server commit toggle → config refetch vẫn external=OFF → dialog Mời
 * hiện banner "ngoài miền" → submit mù → ChatGPT từ chối silently → VERIFY_FAILED
 * (user report 2026-07-15).
 *
 * → CHỈ khi bật ON (target=true): chờ thêm 1 khoảng để server chốt + đọc lại DOM
 * xác nhận vẫn giữ ON (không bị revert bởi toast lỗi) TRƯỚC khi trả về caller.
 * Tắt OFF (cleanup) không cần — không có bước phụ thuộc phía sau.
 */
async function settleServerCommit(target: boolean): Promise<void> {
  if (target !== true) return;
  await sleep(2_000);
  const after = readStateFresh();
  if (after !== true) {
    console.warn(
      `[autogpt-external-invites] toggle bị revert về ${after} sau settle 2s — org-config có thể chưa ON; caller nên xác minh banner trước khi submit.`,
    );
  } else {
    console.log(
      "[autogpt-external-invites] settle 2s: toggle vẫn ON — server đã kịp chốt, an toàn để reload refetch config.",
    );
  }
}
