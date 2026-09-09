/**
 * Modal "Đổi hạn dùng" cho 1 member — CÓ DUYỆT.
 *
 * NEO THEO NGÀY MUA: admin đặt **Ngày mua** (mặc định = "ngày thêm" log dashboard =
 * last_invited_at ?? created_at, kèm giờ) + **Số tháng** (số chu kỳ sử dụng). Hạn dùng
 * = ngày mua + tháng×30 ngày CHÍNH XÁC tới giây (không chốt cuối ngày). Chế độ VÔ THỜI
 * HẠN = xoá hạn. Client gửi { subscriptionMonths, subscriptionPurchasedAt } → BE tính
 * lại hạn (nguồn chuẩn) + lưu ngày mua. Super-admin: áp ngay. Sub-admin: gửi yêu cầu
 * chờ duyệt. Xem hooks/useSubscriptionApprovals.md.
 *
 * "Ngày thêm" (log dashboard) và "Ngày tham gia ChatGPT" (joined_at scrape) là HAI mốc
 * TÁCH BIỆT — hiển thị tham khảo, không ép bằng nhau.
 *
 * ⚠️ HẠN MỚI + PHÍ Ở CHẾ ĐỘ THEO THÁNG DO **SERVER** CHỐT (`renew-preview`). Không
 * gian thanh toán chung một ngày mỗi tháng thì hạn rơi vào ĐÚNG ngày đó và tiền tính
 * theo số ngày thật tới đó — `mốc + tháng×30` và `đơn giá × số tháng` chỉ đúng ở chế
 * độ 30 ngày. Phép tính tại chỗ bên dưới chỉ là số TẠM cho đỡ trống ô lúc chờ trả lời.
 */
import { useMemo, useState } from "react";
import { useFormatDate, useFormatDateTime, useT } from "../i18n";
import { useAuth } from "../hooks/useAuth";
import { useWallet } from "../hooks/useWallet";
import type { Member } from "../types";
import { formatVnd, type OrderQr } from "../lib/wallet";
import OrderQrModal from "./OrderQrModal";
import {
  useChangeSubscription,
  useCorrectAddDate,
  useRenewSubscription,
} from "../hooks/useSubscriptionApprovals";
import { useRenewPreview, type RenewPreviewItem } from "../hooks/useRenewPreview";
import { CalcRow, RenewCalcRows } from "./RenewCalcRows";

type Mode = "months" | "date" | "unlimited";

/** 1 tháng = 30 ngày (khớp BE SUBSCRIPTION_DAYS_PER_MONTH). */
const DAYS_PER_MONTH = 30;

// Hiển thị hạn/ngày kèm GIỜ tới giây, "DD/MM/YYYY - HH:MM:SS" (khớp bảng Thành
// viên / Gia hạn). Hạn = mốc + 30 ngày chính xác tới giây nên cần hiện đủ giờ.
const PRECISE_TIME: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
};

/** ISO → giá trị cho <input type="datetime-local"> ("YYYY-MM-DDTHH:mm", giờ địa phương). */
function toLocalInputValue(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export function ChangeSubscriptionModal({
  workspaceId,
  member,
  onClose,
  renew = false,
}: {
  workspaceId: string;
  member: Member;
  onClose: () => void;
  /** Mở từ tab Gia hạn: tiêu đề "Gia hạn" (nghĩa cộng dồn — mọi chế độ tháng đều
   *  cộng dồn vào hạn hiện tại). Mặc định false (tab Thành viên: "Đổi hạn dùng"). */
  renew?: boolean;
}) {
  const t = useT();
  const formatDate = useFormatDate();
  const formatDateTime = useFormatDateTime();
  // "DD/MM/YYYY - HH:MM:SS" — ngày kèm giờ tới giây.
  const fmtDateTime = (value: string | Date) =>
    formatDateTime(value, undefined, PRECISE_TIME).replace(" ", " - ");
  const { user } = useAuth();
  const [mode, setMode] = useState<Mode>("months");
  const [months, setMonths] = useState(member.subscription_months ?? 1);
  // Chế độ "Theo ngày cụ thể": đặt thẳng NGÀY HẾT HẠN (thêm/bớt ngày tuỳ ý) →
  // gửi subscriptionEndAt. Mặc định = hạn hiện tại, else bây giờ.
  const [endAt, setEndAt] = useState(
    () =>
      toLocalInputValue(member.subscription_end_at) ||
      toLocalInputValue(new Date().toISOString()),
  );
  // Ví không đủ khi gia hạn → BE trả hoá đơn QR (feature 003); mở modal QR.
  const [qrOrder, setQrOrder] = useState<OrderQr | null>(null);
  const change = useChangeSubscription(workspaceId, {
    onPaymentRequired: (order) => setQrOrder(order),
  });
  const correctAddDate = useCorrectAddDate(workspaceId);
  const renewSub = useRenewSubscription(workspaceId, {
    onPaymentRequired: (order) => setQrOrder(order),
  });

  const isSub = !user?.is_super_admin;
  const monthsValid = months >= 1 && months <= 60;
  const endDate = useMemo(() => {
    if (!endAt) return null;
    const d = new Date(endAt);
    return Number.isNaN(d.getTime()) ? null : d;
  }, [endAt]);
  // Thêm/bớt ngày nhanh cho chế độ "ngày cụ thể".
  const shiftEndDays = (days: number) => {
    const base = endAt ? new Date(endAt) : new Date();
    if (Number.isNaN(base.getTime())) return;
    base.setDate(base.getDate() + days);
    setEndAt(toLocalInputValue(base.toISOString()));
  };
  const valid =
    mode === "unlimited" ||
    (mode === "months" && monthsValid) ||
    (mode === "date" && !!endDate);

  // ===== Sửa "Ngày thêm" (mốc neo tính hạn) — staged, Áp dụng mới commit =====
  // "Ngày thêm" = subscription_purchased_at (fallback legacy). Hạn = mốc này + tháng×30.
  const addedAt =
    member.subscription_purchased_at ??
    member.last_invited_at ??
    member.created_at;
  // Sửa ĐÚNG 1 LẦN (super-admin) — dùng chung endpoint correct_add_date (khoá bằng
  // add_date_corrected_at, 409 nếu đã sửa).
  const canEditAddDate = !isSub && !member.add_date_corrected_at;
  const [editingAddDate, setEditingAddDate] = useState(false);
  const [addDateInput, setAddDateInput] = useState(() =>
    toLocalInputValue(addedAt),
  );
  // "Lưu" KHÔNG gọi API ngay — chỉ GIỮ ngày mới (ISO); phải bấm "Áp dụng" mới commit
  // → mọi thay đổi áp cùng 1 mốc thời gian, đồng nhất.
  const [pendingAddDate, setPendingAddDate] = useState<string | null>(null);

  // ISO ngày thêm SẼ áp: đang sửa → input; đã "Lưu" (chờ) → pendingAddDate; else null.
  const effectiveAddDateIso = useMemo<string | null>(() => {
    if (editingAddDate) {
      if (!addDateInput) return null;
      const d = new Date(addDateInput);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    return pendingAddDate;
  }, [editingAddDate, addDateInput, pendingAddDate]);
  // ĐÃ "Lưu" ngày thêm (commit, chờ Áp dụng) → chuyển modal sang chế độ "NEO theo
  // ngày thêm". KHÔNG bật khi mới bấm "Sửa" (đang gõ): nếu bật lúc đang gõ, bộ chọn
  // chế độ + ô Số tháng + dòng "Hạn dùng đến" biến mất → modal trông như lỗi (nhất là
  // member KHÔNG có gói tháng, ẩn gần hết). Chỉ đổi chế độ khi user thực sự commit.
  const anchorEditActive = pendingAddDate != null;

  // GIA HẠN THƯỜNG = CỘNG DỒN (BE _resolve_end_at nhánh 3, chỉ gửi số tháng):
  //   - Còn hạn (hạn hiện tại > bây giờ) → cộng tiếp từ HẠN CŨ.
  //   - Đã hết hạn / chưa có hạn → cộng từ BÂY GIỜ.
  const renewBaseMs = useMemo(() => {
    const nowMs = Date.now();
    const endMs = member.subscription_end_at
      ? new Date(member.subscription_end_at).getTime()
      : 0;
    return endMs > nowMs ? endMs : nowMs;
  }, [member.subscription_end_at]);

  // "Hạn dùng đến" (kết quả sau Áp dụng):
  //   - Đang sửa ngày thêm → NEO: ngày thêm mới + Số tháng×30 (KHÔNG cộng dồn). Áp
  //     dụng cho MỌI member (kể cả chưa có gói) — nhập Số tháng thì tính thẳng từ
  //     ngày thêm mới; BE correct_add_date nhận months tương ứng.
  //   - Gia hạn thường (mode months) → CỘNG DỒN từ hạn hiện tại.
  const localEnd = useMemo<Date | null>(() => {
    if (anchorEditActive) {
      if (!monthsValid || !effectiveAddDateIso) return null;
      return new Date(
        new Date(effectiveAddDateIso).getTime() +
          months * DAYS_PER_MONTH * 86_400_000,
      );
    }
    if (mode !== "months" || !monthsValid) return null;
    return new Date(renewBaseMs + months * DAYS_PER_MONTH * 86_400_000);
  }, [
    anchorEditActive,
    monthsValid,
    effectiveAddDateIso,
    months,
    mode,
    renewBaseMs,
  ]);

  // HẠN THẬT + PHÍ THẬT do server chốt. Chỉ hỏi ở chế độ THEO THÁNG: "theo ngày cụ
  // thể" là admin tự đặt mốc (backend không tính lại), "vô thời hạn" thì không có hạn
  // nào để hỏi. Đang GÕ ngày thêm thì chưa hỏi — chờ bấm "Lưu" mới có mốc neo thật.
  const preview = useRenewPreview(
    [{ id: member.id, workspace_id: workspaceId }],
    months,
    {
      enabled: mode === "months" && monthsValid && !editingAddDate,
      purchasedAt: anchorEditActive ? pendingAddDate : null,
    },
  );
  const previewItem: RenewPreviewItem | null =
    preview.data?.byMember.get(member.id) ?? null;
  const serverEnd = previewItem?.to ? new Date(previewItem.to) : null;
  // Số của server là nguồn đúng; `localEnd` chỉ đỡ trống ô trong lúc chờ trả lời.
  const appliedEnd = mode === "months" ? serverEnd ?? localEnd : localEnd;
  // CHƯA có câu trả lời ĐÚNG CHO SỐ THÁNG ĐANG GÕ → hiện "…" thay vì con số cũ.
  // `keepPreviousData` giữ kết quả của lượt trước trong cache, nên gõ 1 → 3 mà chỉ
  // xét `!previewItem` thì màn hình vẫn in đậm hạn và tiền của 1 tháng như thể đã
  // chốt, đứng ngay cạnh ô ghi 3. Người đọc nhớ con số ĐẦU TIÊN họ thấy.
  const previewPending =
    mode === "months" &&
    monthsValid &&
    !editingAddDate &&
    !preview.isError &&
    (preview.isFetching || !previewItem);

  // Kết quả hạn CUỐI sẽ áp (khớp theo mode): dùng cho mũi tên "hạn hiện tại → mới".
  //   - Vô thời hạn → null (xoá hạn).
  //   - Theo ngày cụ thể → endDate (đã tinh chỉnh ±ngày).
  //   - Theo tháng → appliedEnd (ngày thêm/hiện tại + tháng×30).
  const finalEnd = mode === "unlimited" ? null : mode === "date" ? endDate : appliedEnd;
  // "Hạn hiện tại → mới": hiện khi đang sửa ngày thêm (khớp mốc cuối theo mode).
  // Luồng đó KHÔNG gia hạn và không thu tiền, nên nó giữ mũi tên gọn ở đầu modal còn
  // THẺ KẾT QUẢ (nói "sau khi gia hạn") thì tắt — hai chỗ cùng hiện một con số với
  // hai cách gọi khác nhau là đọc thành hai kết quả.
  const previewNewEnd = anchorEditActive ? finalEnd : null;
  // Ô "Số tháng" CHỈ hiện ở chế độ theo tháng. Ở "Theo ngày cụ thể" thì ngày hết hạn
  // được seed từ hạn vừa tính rồi admin ±ngày tuỳ ý → ẩn Số tháng để khỏi 2 mốc lẫn nhau.
  const showMonthsInput = mode === "months";

  // Bật tab "Theo ngày cụ thể" → SEED ô "Ngày hết hạn mới" = hạn vừa tính (theo tháng /
  // ngày thêm), để admin tinh chỉnh ±ngày từ mốc đó ("sự kết hợp"). Fallback: hạn hiện tại.
  const switchMode = (m: Mode) => {
    if (m === "date") {
      const base =
        appliedEnd ??
        (member.subscription_end_at
          ? new Date(member.subscription_end_at)
          : null);
      if (base) setEndAt(toLocalInputValue(base.toISOString()));
    }
    setMode(m);
  };

  // "Lưu": chỉ GIỮ ngày mới lại (chưa gọi API) rồi thu gọn ô sửa.
  const saveAddDate = () => {
    if (!addDateInput) return;
    const d = new Date(addDateInput);
    if (Number.isNaN(d.getTime())) return;
    setPendingAddDate(d.toISOString());
    setEditingAddDate(false);
  };

  const busy = change.isPending || correctAddDate.isPending || renewSub.isPending;
  // Gia hạn tự phục vụ (tab Gia hạn, theo tháng, không sửa ngày neo) → áp NGAY,
  // KHÔNG qua duyệt kể cả sub-admin → nút hiện "Áp dụng" thay vì "Gửi yêu cầu".
  const isRenewImmediate = renew && mode === "months" && !pendingAddDate;

  // ── Phí gia hạn/đổi hạn (feature 003, user 2026-07-13) ─────────────────────
  // Phí = ĐƠN GIÁ/tháng (member.fee_vnd > wallet.invite_fee_vnd mặc định) × SỐ THÁNG
  // kéo dài. Tính khi KÉO DÀI hạn (gia hạn theo tháng, hoặc đổi hạn theo ngày xa hơn);
  // rút ngắn / vô thời hạn / sửa ngày neo → miễn phí. Chỉ user bật Ví & không super-admin.
  const { data: wallet } = useWallet();
  const chargeable = !!user?.wallet_beta && !user?.is_super_admin;
  const feePerMonth = member.fee_vnd ?? wallet?.invite_fee_vnd ?? 0;
  // Số tháng SẼ bị tính phí (khớp BE): sửa ngày neo → 0; theo tháng → months;
  // theo ngày & xa hơn hạn hiện tại → chênh lệch/30 (làm tròn lên); vô thời hạn → 0.
  const chargeMonths = (() => {
    if (pendingAddDate) return 0; // sửa ngày neo (correct_add_date) không tính phí
    if (mode === "months") return monthsValid ? months : 0;
    if (mode === "date" && endDate && member.subscription_end_at) {
      const cur = new Date(member.subscription_end_at).getTime();
      if (endDate.getTime() > cur) {
        return Math.max(1, Math.ceil((endDate.getTime() - cur) / (DAYS_PER_MONTH * 86_400_000)));
      }
    }
    return 0;
  })();
  // Ở chế độ theo tháng, PHÍ do server chốt (gia hạn giữa kỳ chỉ trả phần lẻ tới ngày
  // thanh toán của không gian, không phải trọn một đơn giá). "Theo ngày cụ thể" thì
  // backend vẫn tính theo số tháng kéo dài nên ước tính tại chỗ là khớp.
  const localFee = feePerMonth * chargeMonths;
  const renewFee =
    mode === "months" && previewItem != null ? previewItem.fee : localFee;
  const showRenewFee = chargeable && (previewPending || renewFee > 0);
  const walletBalance = wallet?.balance ?? 0;
  const feeInsufficient = showRenewFee && !previewPending && walletBalance < renewFee;

  // ── Thẻ "Cách tính phí" (thay cho popup chi tiết cũ) ───────────────────────
  // Popup thứ hai mở đè lên modal này nên chữ bị che gần hết — giải thích mà đọc
  // không ra thì bằng không có. Nay bày thẳng trong modal.
  // Sửa "Ngày thêm" thì không thu tiền (BE correct_add_date) → giấu cả thẻ.
  const showCalcCard = showRenewFee && !pendingAddDate;
  // Hạn ĐANG có: ưu tiên số server vừa trả (cùng một lượt hỏi với hạn mới) để hai
  // đầu mũi tên không bao giờ lệch nguồn.
  const curEndIso = previewItem?.current_end_at ?? member.subscription_end_at;

  // Áp dụng bật khi: đã Lưu ngày thêm (theo mode: tháng→Số tháng hợp lệ, ngày→có ngày,
  // vô thời hạn→luôn được) HOẶC thay đổi hạn hợp lệ.
  const applyEnabled = pendingAddDate
    ? mode === "unlimited"
      ? true
      : mode === "date"
        ? !!endDate
        : monthsValid
    : valid;

  const submit = () => {
    if (busy) return;
    // ƯU TIÊN sửa "Ngày thêm" đã Lưu: NEO lại theo mode đang chọn — đều qua BE
    // correct_add_date (đặt subscription_purchased_at = ngày thêm + KHOÁ sửa 1 lần):
    //   - Vô thời hạn → clearEnd (xoá hạn).
    //   - Theo ngày cụ thể → endAt (ngày hết hạn đã tinh chỉnh, đặt thẳng).
    //   - Theo tháng → months (hạn = ngày thêm + tháng×30).
    if (pendingAddDate) {
      if (mode === "unlimited") {
        correctAddDate.mutate(
          { memberId: member.id, addDate: pendingAddDate, clearEnd: true },
          { onSuccess: () => onClose() },
        );
      } else if (mode === "date") {
        if (!endDate) return;
        correctAddDate.mutate(
          {
            memberId: member.id,
            addDate: pendingAddDate,
            endAt: endDate.toISOString(),
          },
          { onSuccess: () => onClose() },
        );
      } else {
        if (!monthsValid) return;
        correctAddDate.mutate(
          { memberId: member.id, addDate: pendingAddDate, months },
          { onSuccess: () => onClose() },
        );
      }
      return;
    }
    if (!valid) return;
    // GIA HẠN tự phục vụ (tab Gia hạn, theo tháng) → endpoint renew: áp NGAY, tạo
    // chu kỳ mới + reset 'chưa thanh toán', KHÔNG qua duyệt.
    if (isRenewImmediate) {
      if (!monthsValid) return;
      renewSub.mutate(
        { memberId: member.id, months },
        { onSuccess: () => onClose() },
      );
      return;
    }
    // Theo tháng → CHỈ gửi số tháng (không kèm ngày mua) → BE gia hạn cộng dồn:
    // hạn cũ (nếu còn) + tháng×30, hoặc bây giờ + tháng×30 nếu đã hết hạn.
    const vars =
      mode === "months"
        ? { memberId: member.id, subscriptionMonths: months }
        : mode === "date"
          ? { memberId: member.id, subscriptionEndAt: endDate!.toISOString() }
          : { memberId: member.id };
    change.mutate(vars, { onSuccess: () => onClose() });
  };

  return (
    <>
    {qrOrder && (
      <OrderQrModal
        order={qrOrder}
        onClose={() => setQrOrder(null)}
        onPaid={() => onClose()}
      />
    )}
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      style={{ padding: 16 }}
    >
      <div
        className="bg-white rounded-lg shadow-xl"
        style={{
          width: "100%",
          maxWidth: 460,
          maxHeight: "calc(90vh / var(--ui-scale))",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            padding: "16px 20px 12px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            {renew ? t("subscription.renewTitle") : t("subscription.changeTitle")}
          </h3>
        </div>

        <div
          style={{
            padding: "16px 20px",
            display: "grid",
            gap: 12,
            overflowY: "auto",
            flex: 1,
            minHeight: 0,
          }}
        >
          <div style={{ fontSize: 13 }}>
            <span className="cell-muted">{member.email}</span>
            <div style={{ marginTop: 2 }}>
              {t("subscription.currentLabel")}:{" "}
              {/* Cùng nguồn với thẻ kết quả (`curEndIso`): danh sách trong cache có
                  thể cũ hơn câu trả lời server vừa lấy, để hai nguồn là hai con số
                  "hạn hiện tại" khác nhau cách nhau ba dòng. */}
              <strong>
                {curEndIso
                  ? fmtDateTime(curEndIso)
                  : t("subscription.unlimited")}
              </strong>
              {/* Sửa ngày thêm → hạn hiện tại đổi: hiện "cũ → mới". */}
              {previewNewEnd && (
                <>
                  {" → "}
                  <strong style={{ color: "var(--accent)" }}>
                    {fmtDateTime(previewNewEnd.toISOString())}
                  </strong>
                </>
              )}
            </div>
            {/* Ngày thêm = mốc neo hạn. Super-admin sửa ĐÚNG 1 LẦN → hạn hiện tại
                tính lại. "Hạn dùng đến" (gia hạn cộng dồn) bên dưới KHÔNG đổi. */}
            <div style={{ marginTop: 2 }} className="cell-muted">
              {t("subscription.addedAtLabel")}:{" "}
              {editingAddDate ? (
                <span
                  style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}
                >
                  <input
                    type="datetime-local"
                    className="form-input"
                    style={{ width: "auto" }}
                    value={addDateInput}
                    onChange={(e) => setAddDateInput(e.target.value)}
                  />
                  {/* "Lưu" = giữ ngày mới lại (CHƯA áp) — phải bấm Áp dụng mới đổi. */}
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={saveAddDate}
                    disabled={!addDateInput}
                  >
                    {t("common.save")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setEditingAddDate(false)}
                  >
                    {t("common.cancel")}
                  </button>
                </span>
              ) : pendingAddDate ? (
                // Đã "Lưu" ngày mới nhưng CHƯA áp — hiện ngày mới + nhắc bấm Áp dụng.
                <span
                  style={{ display: "inline-flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
                >
                  <strong style={{ color: "var(--accent)" }}>
                    {fmtDateTime(pendingAddDate)}
                  </strong>
                  <span style={{ fontSize: 11 }}>({t("addDate.pendingHint")})</span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ padding: "0 6px", fontSize: 12 }}
                    onClick={() => {
                      setAddDateInput(toLocalInputValue(pendingAddDate));
                      setEditingAddDate(true);
                    }}
                    disabled={busy}
                  >
                    {t("addDate.editBtn")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ padding: "0 6px", fontSize: 12 }}
                    onClick={() => setPendingAddDate(null)}
                    disabled={busy}
                  >
                    {t("addDate.undo")}
                  </button>
                </span>
              ) : (
                <span
                  style={{ display: "inline-flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
                >
                  {addedAt ? fmtDateTime(addedAt) : "—"}
                  {canEditAddDate && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ padding: "0 6px", fontSize: 12 }}
                      onClick={() => {
                        setAddDateInput(toLocalInputValue(addedAt));
                        setEditingAddDate(true);
                      }}
                    >
                      {t("addDate.editBtn")}
                    </button>
                  )}
                  {member.add_date_corrected_at && (
                    <span className="cell-muted" style={{ fontSize: 11 }}>
                      ({t("addDate.locked")})
                    </span>
                  )}
                </span>
              )}
            </div>
            {/* Ngày tham gia ChatGPT (joined_at scrape) — tham khảo, tách biệt. */}
            {member.joined_at && (
              <div style={{ marginTop: 2 }} className="cell-muted">
                {t("subscription.chatgptJoinedLabel")}:{" "}
                {formatDate(member.joined_at)}
              </div>
            )}
          </div>

          {/* Chọn chế độ. "Theo ngày cụ thể" và "Vô thời hạn" CHỈ super-admin —
              tài khoản phụ chỉ được gia hạn theo số tháng (cộng dồn). LUÔN hiển thị,
              kể cả khi đang sửa ngày thêm — không ẩn để tránh modal trông như mất
              thông tin (nhất là member không có gói tháng). */}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(["months", "date", "unlimited"] as Mode[])
              .filter((m) => m === "months" || !isSub)
              .map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => switchMode(m)}
                className={`row-action neutral${mode === m ? " active" : ""}`}
                style={{
                  border: "1px solid var(--border)",
                  background: mode === m ? "var(--surface-2)" : "transparent",
                  fontWeight: mode === m ? 600 : 400,
                }}
              >
                {t(`subscription.mode_${m}`)}
              </button>
            ))}
          </div>

          {showMonthsInput && (
            <>
              {/* Số tháng. Gia hạn thường → cộng dồn; đang sửa ngày thêm → NEO
                  (hạn = ngày thêm + tháng×30, đổi số tháng thì hạn tính lại từ ngày thêm). */}
              <label style={{ fontSize: 13, display: "grid", gap: 4 }}>
                <span className="cell-muted">
                  {t("subscription.monthsLabel")}
                </span>
                <input
                  type="number"
                  min={1}
                  max={60}
                  className="form-input"
                  value={months}
                  onChange={(e) => setMonths(Number(e.target.value))}
                  autoFocus={!anchorEditActive}
                />
              </label>
              {/* THẺ KẾT QUẢ — câu hỏi đầu tiên của người bán là "khách dùng tới
                  bao giờ", nên hạn mới đứng trên tiền và to hơn mọi thứ quanh nó. */}
              {!anchorEditActive && (appliedEnd || previewPending) && (
                <div
                  style={{
                    padding: "10px 12px",
                    background: "var(--success-bg)",
                    border: "1px solid var(--success-border)",
                    borderRadius: "var(--radius)",
                    display: "grid",
                    gap: 4,
                  }}
                >
                  <div
                    style={{
                      fontSize: 10.5,
                      fontWeight: 600,
                      letterSpacing: "0.07em",
                      textTransform: "uppercase",
                      color: "var(--ink-3)",
                    }}
                  >
                    {renew
                      ? t("subscription.renewResultLabel")
                      : t("renewals.nextExpiry")}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      alignItems: "baseline",
                      gap: "2px 8px",
                    }}
                  >
                    <span
                      style={{
                        fontSize: 12.5,
                        fontFamily: "var(--font-mono)",
                        color: "var(--ink-3)",
                      }}
                    >
                      {curEndIso
                        ? fmtDateTime(curEndIso)
                        : t("subscription.unlimited")}
                    </span>
                    <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>
                      →
                    </span>
                    {/* Chờ server thì hiện "…", KHÔNG hiện số tính tạm: người đọc
                        nhớ con số ĐẦU TIÊN họ thấy, không nhớ con số thay thế nó. */}
                    <strong
                      style={{
                        fontSize: 15,
                        fontWeight: 700,
                        fontFamily: "var(--font-mono)",
                        color: "var(--success)",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {previewPending || !appliedEnd
                        ? "…"
                        : fmtDateTime(appliedEnd.toISOString())}
                    </strong>
                  </div>
                  {/* Không gian thanh toán chung một ngày mỗi tháng: nói vì sao hạn
                      rơi đúng ngày đó, kẻo người bán tưởng hệ thống cộng nhầm. */}
                  {previewItem?.cycle_days != null && (
                    <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                      {t("subscription.renewOnPayday")}
                    </div>
                  )}
                </div>
              )}
              {/* Hỏi hụt (mất mạng, hết phiên) thì nói thẳng là số đang hiện chỉ
                  ước tính, đừng để người bán tưởng đó là con số đã chốt. */}
              {preview.isError && (
                <div style={{ fontSize: 12, color: "var(--danger)" }}>
                  {t("subscription.previewFailed")}
                </div>
              )}
              {/* THẺ CÁCH TÍNH — mọi con số đều của server, web chỉ ghép nhãn. */}
              {showCalcCard && (
                <div
                  style={{
                    padding: "10px 12px",
                    background: "var(--surface-2)",
                    border: `1px solid ${feeInsufficient ? "var(--danger-border)" : "var(--border)"}`,
                    borderRadius: "var(--radius)",
                    display: "grid",
                    gap: 6,
                  }}
                >
                  <div
                    style={{
                      fontSize: 10.5,
                      fontWeight: 600,
                      letterSpacing: "0.07em",
                      textTransform: "uppercase",
                      color: "var(--ink-3)",
                    }}
                  >
                    {t("subscription.calcTitle")}
                  </div>
                  {/* Đang hỏi lại (đổi số tháng) thì NGƯNG bày phân rã: dòng tổng
                      hiện "…" mà mấy dòng khoản vẫn in số của lượt trước là thẻ tự
                      mâu thuẫn với chính nó — lúc đó chỉ còn đúng dòng tổng. */}
                  {previewItem && !previewPending ? (
                    <RenewCalcRows
                      item={previewItem}
                      months={months}
                      totalLabel={t("subscription.renewFeeLabel")}
                    />
                  ) : (
                    <CalcRow
                      strong
                      label={t("subscription.renewFeeLabel")}
                      value={previewPending ? "…" : formatVnd(renewFee)}
                    />
                  )}
                  <div
                    style={{
                      fontSize: 11,
                      color: feeInsufficient ? "var(--danger)" : "var(--ink-3)",
                    }}
                  >
                    {feeInsufficient
                      ? t("invite.feeBalanceInsufficient", {
                          balance: formatVnd(walletBalance),
                        })
                      : t("invite.feeBalance", {
                          balance: formatVnd(walletBalance),
                        })}
                  </div>
                </div>
              )}
            </>
          )}
          {mode === "date" && (
            <>
              <label style={{ fontSize: 13, display: "grid", gap: 4 }}>
                <span className="cell-muted">{t("subscription.dateLabel")}</span>
                <input
                  type="datetime-local"
                  className="form-input"
                  value={endAt}
                  onChange={(e) => setEndAt(e.target.value)}
                  autoFocus
                />
              </label>
              {/* Thêm/bớt ngày nhanh — chỉnh chi tiết tới từng ngày. */}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {[-7, -1, 1, 7, 30].map((d) => (
                  <button
                    key={d}
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{
                      border: "1px solid var(--border)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                    onClick={() => shiftEndDays(d)}
                  >
                    {d > 0 ? `+${d}d` : `${d}d`}
                  </button>
                ))}
              </div>
              {endDate && (
                <div style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
                  {t("subscription.computedHint", {
                    date: fmtDateTime(endDate.toISOString()),
                  })}
                </div>
              )}
            </>
          )}
          {mode === "unlimited" && (
            <div style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
              {t("subscription.unlimitedHint")}
            </div>
          )}

        </div>

        <div
          style={{
            padding: "12px 20px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onClose}
            disabled={busy}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={submit}
            disabled={busy || editingAddDate || !applyEnabled}
          >
            {busy ? t("common.loading") : t("subscription.submitApply")}
          </button>
        </div>
      </div>
    </div>
    </>
  );
}
