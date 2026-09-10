import { Fragment, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useFormatDateTime, useI18n, useT } from "../i18n";
import type { AddedMember, Member } from "../types";
import { toast } from "./Toast";
import { MemberDetailModal } from "./MemberDetailModal";
import { ChangeSubscriptionModal } from "./ChangeSubscriptionModal";
import { SearchInput } from "../pages/Members";
import { useAuth } from "../hooks/useAuth";
import { useIsMobile } from "../hooks/useIsMobile";
import { useRenewPreview } from "../hooks/useRenewPreview";
import { formatVnd, getQrOrder, type OrderQr } from "../lib/wallet";
import { formatVnDate } from "../lib/cycle-time";
import OrderQrModal from "./OrderQrModal";
import { CalcCard, CalcChevron, RenewCalcRows } from "./RenewCalcRows";

// Cột ngày hiển thị tới giây, khớp bảng Thành viên (Members.tsx / AddedEmails.tsx).
const PRECISE_TIME: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
};
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_DAYS = 30;

/** Hạn tiếp theo TÍNH TẠM: còn hạn → hạn cũ + tháng×30; hết hạn → bây giờ + tháng×30.
 *
 *  ⚠️ CHỈ để lấp ô trong lúc chờ server trả lời. Không gian thanh toán chung một ngày
 *  mỗi tháng cho hạn rơi vào ĐÚNG ngày đó, không phải cộng 30 ngày — con số thật lấy
 *  từ `useRenewPreview`. Export vì popup "đến hạn theo tuần" ở trang Tổng quan cũng
 *  dùng chung phần dự phòng này. */
export function nextEndAfterRenew(
  endAt: string | null,
  months: number,
): Date {
  const now = Date.now();
  const end = endAt ? new Date(endAt).getTime() : 0;
  const base = end > now ? end : now;
  return new Date(base + months * MONTH_DAYS * DAY_MS);
}

/** "DD/MM/YYYY - HH:MM:SS" — giống fmtRenewExpiry ở Members.tsx. */
function fmtRenewExpiry(
  formatDateTime: ReturnType<typeof useFormatDateTime>,
  value: string | Date,
): string {
  return formatDateTime(value, undefined, PRECISE_TIME).replace(" ", " - ");
}

/** Điều kiện "cần gia hạn": còn active/pending + đã hết hạn HOẶC ≤7 ngày. */
export function isRenewalDue(m: Member): boolean {
  if (m.status !== "active" && m.status !== "pending") return false;
  if (m.subscription_end_at == null) return false;
  const end = new Date(m.subscription_end_at).getTime();
  const now = Date.now();
  return end <= now || end - now <= SEVEN_DAYS_MS;
}

/**
 * Panel "Gia hạn" — gom thành viên SẮP hết hạn (≤7 ngày, còn hiệu lực) và ĐÃ hết hạn
 * (đang chờ scheduler nền tự xoá) thành MỘT danh sách để gia hạn tập trung.
 *
 * Trước đây là trang riêng theo workspace (pages/WorkspaceRenewals.tsx); nay nhận
 * `members` (AddedMember, gom XUYÊN workspace) từ trang "Email đã add" và gia hạn
 * TỪNG DÒNG theo workspace_id của chính nó → không cần :workspaceId route param.
 *
 * KHÔNG tự xoá ở đây: thành viên hết hạn được scheduler nền tự enqueue REMOVE_MEMBER
 * (apps/api/app/main.py, ân hạn ~1 giờ). Gia hạn = CỘNG DỒN (POST .../renew, tự phục
 * vụ, KHÔNG cần duyệt): chỉ gửi số tháng → BE cộng vào hạn hiện tại (còn hạn) hoặc từ
 * bây giờ (đã hết hạn). Xong invalidate ["added-members"]/["members"] → list tự cập nhật.
 */
export function RenewalsPanel({ members }: { members: AddedMember[] }) {
  const t = useT();
  const { lang } = useI18n();
  const formatDateTime = useFormatDateTime();
  const qc = useQueryClient();
  const { user } = useAuth();
  const isMobile = useIsMobile();
  // Cột "Người sở hữu" chỉ hiện cho admin tổng; sub-admin chỉ thấy email mình add nên không cần.
  const isSuper = user?.is_super_admin === true;

  const [detailMember, setDetailMember] = useState<AddedMember | null>(null);
  const [renewMember, setRenewMember] = useState<AddedMember | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkMonths, setBulkMonths] = useState(1);
  const [showBulkConfirm, setShowBulkConfirm] = useState(false);
  // Những email đang bung phần "cách tính phí" trong popup gia hạn hàng loạt. Cho mở
  // NHIỀU dòng một lúc: người bán hay đặt hai email cạnh nhau để xem vì sao lệch tiền.
  const [openCalc, setOpenCalc] = useState<Set<string>>(new Set());
  // Ví không đủ khi gia hạn → BE trả hoá đơn QR (402); mở modal QR thay vì báo lỗi.
  const [qrOrder, setQrOrder] = useState<OrderQr | null>(null);
  const [search, setSearch] = useState("");

  // Gộp SẮP + ĐÃ hết hạn thành 1 danh sách; đã hết hạn (khẩn nhất) lên trước, rồi
  // tới hạn gần nhất. Không chia section.
  const baseRows = useMemo(() => {
    const list = members.filter(isRenewalDue);
    return list.sort(
      (a, b) =>
        new Date(a.subscription_end_at as string).getTime() -
        new Date(b.subscription_end_at as string).getTime(),
    );
  }, [members]);

  // Lọc theo ô tìm kiếm (email hoặc tên). Tách khỏi baseRows để ô tìm kiếm vẫn
  // hiển thị (và xoá được) khi không có kết quả khớp.
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return baseRows;
    return baseRows.filter(
      (m) =>
        m.email.toLowerCase().includes(s) ||
        (m.name ?? "").toLowerCase().includes(s),
    );
  }, [baseRows, search]);

  const selectedCount = rows.filter((m) => selectedIds.has(m.id)).length;
  const allSelected = rows.length > 0 && selectedCount === rows.length;

  const toggle = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setSelectedIds(allSelected ? new Set() : new Set(rows.map((m) => m.id)));

  // Gia hạn HÀNG LOẠT: lặp endpoint per-member (POST .../renew) theo workspace_id
  // của TỪNG dòng (danh sách gom xuyên workspace) — chỉ gửi số tháng → BE cộng dồn
  // + tạo chu kỳ mới + reset 'chưa thanh toán'. Gia hạn là TỰ PHỤC VỤ (áp NGAY,
  // KHÔNG cần duyệt — kể cả sub-admin). Gom 1 toast tổng kết thay vì N toast.
  //
  // TUẦN TỰ và DỪNG ở email đầu tiên ví không đủ tiền (giống popup "đến hạn" ở trang
  // Tổng quan): mỗi email thiếu tiền sinh MỘT hoá đơn QR riêng, bắn cả loạt cùng lúc
  // là người dùng lãnh một xấp mã QR chồng nhau mà màn hình chỉ báo "N lỗi". Quét
  // xong mã đầu tiên thì bấm lại để chạy tiếp phần còn lại.
  const bulkRenew = useMutation({
    mutationFn: async (vars: { rows: AddedMember[]; months: number }) => {
      // Gom id đã xong rồi mới bỏ chọn MỘT LẦN ở `onSuccess`: bỏ dần trong lúc chạy
      // thì bảng xác nhận rụng từng dòng và bản xem trước bị hỏi lại sau mỗi email.
      const done: string[] = [];
      for (const m of vars.rows) {
        try {
          await api(`/api/v1/workspaces/${m.workspace_id}/members/${m.id}/renew`, {
            method: "POST",
            body: JSON.stringify({ months: vars.months }),
          });
          done.push(m.id);
        } catch (e) {
          const order = getQrOrder(e);
          if (order) return { done, order, err: null };
          return { done, order: null, err: e };
        }
      }
      return { done, order: null, err: null };
    },
    onSuccess: ({ done, order, err }) => {
      qc.invalidateQueries({ queryKey: ["added-members"] });
      qc.invalidateQueries({ queryKey: ["members"] });
      qc.invalidateQueries({ queryKey: ["member-logs"] });
      if (done.length > 0) {
        toast.success(t("renewals.bulkResultOk", { n: done.length }));
      }
      if (order || err) {
        // Dừng giữa chừng: bỏ chọn phần đã xong, GIỮ phần còn lại để bấm tiếp sau
        // khi trả tiền (hoặc sau khi xử lý lỗi).
        setSelectedIds((prev) => {
          const next = new Set(prev);
          for (const id of done) next.delete(id);
          return next;
        });
        if (order) setQrOrder(order);
        else toast.error(err instanceof Error ? err.message : String(err));
        return;
      }
      setSelectedIds(new Set());
      setShowBulkConfirm(false);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  // Danh sách thành viên đã chọn (giữ thứ tự bảng) — dùng cho popup preview.
  const selectedRows = useMemo(
    () => rows.filter((m) => selectedIds.has(m.id)),
    [rows, selectedIds],
  );

  // HẠN MỚI + PHÍ của TỪNG dòng do server chốt (danh sách gom xuyên không gian nên
  // hook tự chia nhóm theo không gian). Trước đây popup cộng 30 ngày cho mọi dòng:
  // ở không gian thanh toán chung một ngày, hạn rơi vào ngày đó và tiền tính theo số
  // ngày thật — bảng xác nhận báo một đằng, bấm xong ra một nẻo.
  const preview = useRenewPreview(
    selectedRows.map((m) => ({ id: m.id, workspace_id: m.workspace_id })),
    bulkMonths,
    { enabled: showBulkConfirm },
  );
  /** Hạn mới của một dòng.
   *
   *  Đang chờ server thì hiện "…" chứ KHÔNG nháy số tính tạm: người đọc nhớ con số
   *  đầu tiên họ thấy, số thay thế nó vài trăm mili giây sau không ai để ý. Chỉ khi
   *  hỏi hụt hẳn mới rơi về số tạm để bảng không trống trơn. */
  const nextEndLabel = (m: AddedMember): string => {
    const item = preview.data?.byMember.get(m.id);
    if (item?.to) return fmtRenewExpiry(formatDateTime, item.to);
    if (preview.isError) {
      return fmtRenewExpiry(
        formatDateTime,
        nextEndAfterRenew(m.subscription_end_at, bulkMonths),
      );
    }
    return "…";
  };

  // Có bị trừ tiền không: super-admin (hoặc chưa bật Ví) thì server trả chargeable=false
  // → giấu hẳn cột tiền chứ không hiện 0 đ, vì "0 đ" trông như đang khuyến mãi.
  //
  // Phiên đăng nhập đã BIẾT TRƯỚC câu trả lời, nên dùng nó dựng KHUNG ngay từ nhịp
  // vẽ đầu (con số thì vẫn chờ server): đợi câu trả lời mới mọc thêm cột là popup
  // giật một cái mỗi lần mở.
  const showFee = preview.data?.chargeable ?? (!!user?.wallet_beta && !isSuper);
  // Đổi số tháng thì tiền cũ vẫn còn trong cache một nhịp (keepPreviousData). Với NGÀY
  // thì giữ số cũ còn đỡ, với TIỀN thì không: người bán đọc số rồi báo giá cho khách.
  // Nên trong lúc hỏi lại, mọi ô tiền cùng hiện "…" và cùng sáng lên một lượt.
  const feeLabel = (m: AddedMember): string => {
    // `isPlaceholderData` = số đang hiện là của lượt hỏi TRƯỚC (đổi số tháng). Refetch
    // nền (quay lại tab) không bật cờ này nên bảng không nháy "…" vô cớ.
    if (preview.isPlaceholderData) return "…";
    const item = preview.data?.byMember.get(m.id);
    // KHÔNG tự nhân đơn giá với số tháng để lấp chỗ trống: ở không gian chốt theo
    // chu kỳ, con số đó sai — mà sai im lặng thì tệ hơn hẳn một dấu gạch.
    return item ? formatVnd(item.fee) : "—";
  };
  const totalLabel = preview.isPlaceholderData
    ? "…"
    : formatVnd(preview.data?.totalFee ?? 0);

  // CÁCH TÍNH nói MỘT LẦN ở đầu bảng: một mẻ gia hạn gần như luôn cùng không gian nên
  // chu kỳ và đơn giá giống hệt nhau ở mọi dòng — lặp lại cho từng email là bắt người
  // đọc dò xem có gì khác nhau không, trong khi câu trả lời là "không". Khác nhau
  // (mời lẫn hai không gian) thì thôi không nói, vì lúc đó câu chung không còn đúng.
  const pvRows = preview.data?.rows ?? [];
  const sameValue = (pick: (r: (typeof pvRows)[number]) => string | null) => {
    const vals = new Set(pvRows.map(pick));
    return pvRows.length > 0 && vals.size === 1 ? [...vals][0] : null;
  };
  const sharedCycle = sameValue((r) =>
    r.cycle_start && r.cycle_end && r.cycle_days != null
      ? t("subscription.calcCycleValue", {
          start: formatVnDate(lang, r.cycle_start),
          end: formatVnDate(lang, r.cycle_end),
          days: r.cycle_days,
        })
      : null,
  );
  // Đơn giá chỉ nói lên tổng ở nhánh tính theo tháng — dùng ĐÚNG điều kiện của khối
  // cách tính (`unitDrivesFee` trong RenewCalcRows), không thì đầu popup in một con
  // số mà khối bung ra của chính email đó cố tình giấu.
  const sharedUnit = sameValue((r) =>
    r.unit_price_vnd != null &&
    (r.cycle_days != null || r.unit_price_vnd * bulkMonths === r.fee)
      ? t("invite.feeDetailUnitValue", { price: formatVnd(r.unit_price_vnd) })
      : null,
  );
  // Con số THÔ của đơn giá chung (cùng điều kiện với `sharedUnit`): băng thông số in
  // riêng số tiền, còn "/ tháng" đưa lên nhãn cho ô ngắn lại, cân với các ô bên.
  const sharedUnitPrice = (() => {
    const v = sameValue((r) =>
      r.unit_price_vnd != null &&
      (r.cycle_days != null || r.unit_price_vnd * bulkMonths === r.fee)
        ? String(r.unit_price_vnd)
        : null,
    );
    return v == null ? null : Number(v);
  })();

  // Ý MUỐN mở nằm ở `openCalc`, nhưng cái được VẼ phải lọc lại: (a) theo danh sách
  // đang chọn — gia hạn xong một phần (hoặc bỏ chọn) mà giữ id cũ thì lần sau email
  // đó vừa chọn lại đã tự bung; (b) theo `showFee` — tài khoản KHÔNG bị trừ tiền thì
  // popup giấu hẳn cột tiền, để khối cách tính bung ra là bày đúng những con số vừa
  // giấu, và con số đó sẽ không bao giờ bị trừ.
  const openIds = useMemo(() => {
    const live = new Set<string>();
    if (!showFee) return live;
    for (const m of selectedRows) if (openCalc.has(m.id)) live.add(m.id);
    return live;
  }, [selectedRows, openCalc, showFee]);
  const toggleCalc = (id: string) => {
    if (!showFee) return;
    setOpenCalc((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** Phần "cách tính phí" của MỘT email — dùng chung cho thẻ mobile và hàng phụ
   *  desktop, dựng bằng đúng khối mà ô gia hạn lẻ đang dùng nên hai màn hình không
   *  giải thích theo hai kiểu.
   *
   *  Chưa có số của server thì nói thẳng là đang chờ / chưa hỏi được. Đây là chỗ
   *  người bán đọc để báo giá cho khách, bịa một con số ở đây là sai kiểu tệ nhất. */
  const renderCalc = (m: AddedMember) => {
    if (!showFee) return null;
    const item = preview.data?.byMember.get(m.id);
    // Đổi số tháng thì số cũ vẫn nằm trong cache thêm một nhịp (keepPreviousData) —
    // giống cột "Thành tiền", khối này cũng phải im trong lúc hỏi lại chứ không bày
    // cách tính của số tháng cũ. Ba trạng thái nói ba câu khác nhau: đang hỏi, hỏi
    // hụt, và server không trả dòng này (email không còn thuộc không gian đó).
    if (preview.isPlaceholderData || !item) {
      return (
        <CalcCard title={t("subscription.calcTitle")}>
          <div className="cell-muted" style={{ fontSize: 12.5 }}>
            {preview.isPlaceholderData
              ? t("common.loading")
              : preview.isError
                ? t("subscription.previewFailed")
                : t("common.empty")}
          </div>
        </CalcCard>
      );
    }
    return (
      <CalcCard title={t("subscription.calcTitle")}>
        {/* `showUnit`/`showCycle`: hai thứ này đã nói một lần ở đầu popup khi cả mẻ
            giống nhau — nhắc lại ở từng email chỉ làm khối dài thêm. Mobile bỏ luôn
            dòng tổng vì thẻ ngay trên đã in đúng con số đó. */}
        <RenewCalcRows
          item={item}
          months={bulkMonths}
          totalLabel={isMobile ? undefined : t("invite.feeDetailFee")}
          showUnit={!sharedUnit}
          showCycle={!sharedCycle}
        />
      </CalcCard>
    );
  };

  return (
    <div>
      {/* Ghi chú luật tự xoá — để admin hiểu thành viên hết hạn sẽ tự bị gỡ. */}
      <div className="notice" style={{ marginBottom: 16 }}>
        <div style={{ flex: 1 }}>
          <div className="notice-body">{t("renewals.autoRemoveNote")}</div>
        </div>
      </div>

      {baseRows.length === 0 ? (
        <div className="surface-card" style={{ padding: 32, textAlign: "center" }}>
          <div className="cell-muted">{t("renewals.empty")}</div>
        </div>
      ) : (
        <div className="table-card renewals-card">
          <div className="table-head">
            <div className="table-title">
              {t("renewals.countLabel", { n: rows.length })}
            </div>
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder={t("renewals.searchPlaceholder")}
            />
            {/* Thanh gia hạn hàng loạt — hiện khi đã chọn ≥1 dòng. */}
            {selectedCount > 0 && (
              <div
                className="flex items-center"
                style={{ gap: 8, flexWrap: "wrap" }}
              >
                <span className="cell-muted" style={{ fontSize: 13 }}>
                  {t("renewals.selectedCount", { n: selectedCount })}
                </span>
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={bulkMonths}
                  onChange={(e) => setBulkMonths(Number(e.target.value))}
                  className="form-input"
                  style={{ width: 64, padding: "6px 8px", fontSize: 13 }}
                  title={t("renewals.monthsUnit")}
                />
                <span className="cell-muted" style={{ fontSize: 13 }}>
                  {t("renewals.monthsUnit")}
                </span>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    // Mỗi lần mở popup là một lượt đọc mới: khối cách tính của lần
                    // trước phải đóng lại, không thì popup vừa hiện ra đã bung sẵn
                    // vài khối chẳng ai vừa bấm.
                    setOpenCalc(new Set());
                    setShowBulkConfirm(true);
                  }}
                  disabled={bulkRenew.isPending || bulkMonths < 1}
                >
                  {t("renewals.bulkRenewBtn", { n: selectedCount })}
                </button>
              </div>
            )}
          </div>
          {isMobile ? (
            /* ---------- Mobile: danh sách THẺ (mỗi email 1 thẻ) ---------- */
            <div className="email-card-list">
              {rows.length === 0 ? (
                <div
                  className="cell-muted"
                  style={{ textAlign: "center", padding: 32 }}
                >
                  {t("renewals.searchEmpty")}
                </div>
              ) : (
                rows.map((m) => (
                  <RenewalCard
                    key={m.id}
                    member={m}
                    checked={selectedIds.has(m.id)}
                    onToggle={() => toggle(m.id)}
                    isSuper={isSuper}
                    t={t}
                    formatDateTime={formatDateTime}
                    onOpenDetail={setDetailMember}
                    onRenew={setRenewMember}
                  />
                ))
              )}
            </div>
          ) : (
            /* ---------- Desktop: bảng đầy đủ ---------- */
            <div style={{ overflowX: "auto" }}>
              <table className="data-table data-table-compact">
                <thead>
                  <tr>
                    <th style={{ width: 40, textAlign: "center" }}>
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={toggleAll}
                        aria-label={t("renewals.selectAll")}
                      />
                    </th>
                    <th>{t("member.colEmail")}</th>
                    {isSuper && <th>Người sở hữu</th>}
                    <th>{t("addedEmails.colRenewedAt")}</th>
                    <th>{t("addedEmails.colExpiry")}</th>
                    <th>{t("renewals.colRemaining")}</th>
                    <th style={{ textAlign: "right" }}>{t("common.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td
                        colSpan={isSuper ? 7 : 6}
                        className="cell-muted"
                        style={{ textAlign: "center", padding: "24px 0" }}
                      >
                        {t("renewals.searchEmpty")}
                      </td>
                    </tr>
                  ) : (
                    rows.map((m) => (
                      <RenewalRow
                        key={m.id}
                        member={m}
                        checked={selectedIds.has(m.id)}
                        onToggle={() => toggle(m.id)}
                        isSuper={isSuper}
                        t={t}
                        formatDateTime={formatDateTime}
                        onOpenDetail={setDetailMember}
                        onRenew={setRenewMember}
                      />
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Popup xác nhận gia hạn hàng loạt — email | hạn hiện tại | hạn tiếp theo |
          thành tiền, khép lại bằng dòng tổng. Mọi thứ người dùng cần để bấm nút nằm
          gọn trong MỘT lớp popup, không mở thêm lớp thứ hai đè lên.
          Kiểu dáng đặt ở index.css (`.renew-*`, `.calc-*`): dùng class thay style
          inline để có hover, mũi tên xoay, đầu cột ghim khi cuộn. */}
      {showBulkConfirm && selectedRows.length > 0 && (
        <div
          className="renew-backdrop fixed inset-0 z-50 flex justify-center"
          // Neo MÉP TRÊN thay vì canh giữa dọc: bung một khối cách tính làm popup cao
          // thêm ~160px, canh giữa thì cả popup trượt lên và dòng vừa bấm chạy khỏi
          // chỗ con trỏ đang chỉ.
          style={{ padding: 16, alignItems: "flex-start", paddingTop: "7vh" }}
        >
          <div
            className="renew-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="renew-bulk-title"
            style={{
              // Có cột tiền thì bảng cần thêm một cột: nới ra để hai cột ngày
              // (dạng "DD/MM/YYYY - HH:MM:SS") không bị bóp cụt.
              maxWidth: showFee ? 780 : 640,
              maxHeight: "calc(85vh / var(--ui-scale))",
            }}
          >
            <div className="renew-modal-head">
              <div style={{ minWidth: 0 }}>
                <h3 id="renew-bulk-title" className="renew-modal-title">
                  {t("renewals.renewBtn")}
                </h3>
                <div className="renew-modal-sub">
                  {t("renewals.bulkConfirm", {
                    n: selectedRows.length,
                    months: bulkMonths,
                  })}
                </div>
              </div>
              <button
                type="button"
                className="renew-close"
                aria-label={t("common.close")}
                onClick={() => setShowBulkConfirm(false)}
                disabled={bulkRenew.isPending}
              >
                ✕
              </button>
            </div>
            {/* THÔNG SỐ của cả mẻ — nói một lần ở đây thay cho popup chi tiết cũ
                (popup đó mở đè lên chính popup này nên đọc không ra). Đơn giá và chu
                kỳ chỉ hiện khi mọi dòng giống nhau, xem `sharedUnit`/`sharedCycle`. */}
            <div className="renew-stats">
              <div className="renew-stat">
                <span className="renew-stat-label">{t("renewals.metaMembers")}</span>
                <span className="renew-stat-value">{selectedRows.length}</span>
              </div>
              <div className="renew-stat">
                <span className="renew-stat-label">{t("renewals.metaMonths")}</span>
                <span className="renew-stat-value">
                  +{bulkMonths} {t("renewals.monthsUnit")}
                </span>
              </div>
              {showFee && sharedUnitPrice != null && (
                <div className="renew-stat">
                  <span className="renew-stat-label">
                    {t("renewals.metaUnitPerMonth")}
                  </span>
                  <span className="renew-stat-value">
                    {formatVnd(sharedUnitPrice)}
                  </span>
                </div>
              )}
              {sharedCycle && (
                <div className="renew-stat">
                  <span className="renew-stat-label">{t("invite.feeDetailCycle")}</span>
                  <span className="renew-stat-value">{sharedCycle}</span>
                </div>
              )}
            </div>
            <div className="renew-modal-body">
              {isMobile ? (
                /* Mobile: mỗi email 1 thẻ — email trên, "hạn cũ → hạn mới" xuống
                   dòng, tiền một dòng riêng. Ba thứ này xếp chồng nên đọc được ở
                   màn 360px mà không phải kéo ngang. */
                <div>
                  {selectedRows.map((m) => {
                    const open = openIds.has(m.id);
                    // Không bị trừ tiền thì không có gì để giải thích — bỏ luôn vẻ
                    // "bấm được" thay vì để bấm mà chẳng ra gì.
                    const canOpen = showFee;
                    return (
                      <div
                        key={m.id}
                        className={open ? "renew-card is-open" : "renew-card"}
                      >
                        {/* Cả thẻ là MỘT nút thật: ngón tay bấm chỗ nào trong thẻ cũng
                            mở được, mà Tab + Enter/Space cũng mở được y hệt. */}
                        <button
                          type="button"
                          className="renew-card-btn"
                          onClick={() => toggleCalc(m.id)}
                          aria-expanded={canOpen ? open : undefined}
                          disabled={!canOpen}
                          title={
                            open
                              ? t("invite.feeDetailHide")
                              : t("invite.feeDetailShow")
                          }
                        >
                          <div className="renew-card-email">
                            {canOpen && <CalcChevron />}
                            <span>{m.email}</span>
                          </div>
                          {/* Ba dòng nhãn trái – giá trị phải, thẳng cột như bảng
                              desktop. Kiểu "hạn cũ → hạn mới" trên một dòng luôn
                              gãy ở mũi tên vì hai chuỗi ngày không vừa 360px. */}
                          <div className="renew-card-row">
                            <span className="renew-card-row-label">
                              {t("renewals.currentExpiry")}
                            </span>
                            <span className="renew-date">
                              {fmtRenewExpiry(
                                formatDateTime,
                                m.subscription_end_at as string,
                              )}
                            </span>
                          </div>
                          <div className="renew-card-row">
                            <span className="renew-card-row-label">
                              {t("renewals.nextExpiry")}
                            </span>
                            <span className="renew-date-next">{nextEndLabel(m)}</span>
                          </div>
                          {showFee && (
                            <div className="renew-card-row">
                              <span className="renew-card-row-label">
                                {t("invite.feeDetailFee")}
                              </span>
                              <span className="renew-fee">{feeLabel(m)}</span>
                            </div>
                          )}
                        </button>
                        {open && (
                          <div className="renew-card-calc">{renderCalc(m)}</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                /* table-layout:fixed → cột cố định, email dài cắt gọn (…), 2 cột
                   ngày luôn hiện đủ, không tràn ngang. Sàn bề rộng để khung bọc cuộn
                   ngang khi cỡ chữ 125% hoặc cửa sổ hẹp, không thì chuỗi ngày (nowrap)
                   tràn đè sang cột bên. */
                <table
                  className="renew-table"
                  style={{ minWidth: showFee ? 700 : 520 }}
                >
                  <thead>
                    <tr>
                      <th style={{ width: showFee ? "34%" : "40%" }}>
                        {t("member.colEmail")}
                      </th>
                      <th style={{ width: showFee ? "24.5%" : "30%" }}>
                        {t("renewals.currentExpiry")}
                      </th>
                      <th style={{ width: showFee ? "24.5%" : "30%" }}>
                        {t("renewals.nextExpiry")}
                      </th>
                      {showFee && (
                        <th style={{ width: "17%", textAlign: "right" }}>
                          {t("invite.feeDetailFee")}
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {selectedRows.map((m) => {
                      const open = openIds.has(m.id);
                      const canOpen = showFee;
                      // `is-open`: hàng email và hàng cách tính đọc như MỘT khối —
                      // chung nền, bỏ vạch kẻ chen giữa, vạch xanh mép trái nối liền.
                      const rowClass = [
                        "renew-row",
                        canOpen ? "can-open" : "",
                        open ? "is-open" : "",
                      ]
                        .filter(Boolean)
                        .join(" ");
                      return (
                        <Fragment key={m.id}>
                          <tr className={rowClass} onClick={() => toggleCalc(m.id)}>
                            <td style={{ overflow: "hidden" }}>
                              {/* Nút THẬT chứ không phải <tr onClick> trơ trọi: Tab tới
                                  rồi Enter/Space là mở được. Cả hàng vẫn bấm được nên
                                  chặn nổi bọt, kẻo một cú bấm đếm hai lần và đóng ngay
                                  cái vừa mở. */}
                              <button
                                type="button"
                                className="renew-email-btn"
                                aria-expanded={canOpen ? open : undefined}
                                disabled={!canOpen}
                                title={
                                  open
                                    ? t("invite.feeDetailHide")
                                    : t("invite.feeDetailShow")
                                }
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleCalc(m.id);
                                }}
                              >
                                {canOpen && <CalcChevron />}
                                <span className="renew-email" title={m.email}>
                                  {m.email}
                                </span>
                              </button>
                            </td>
                            <td className="renew-date">
                              {fmtRenewExpiry(
                                formatDateTime,
                                m.subscription_end_at as string,
                              )}
                            </td>
                            <td className="renew-date-next">{nextEndLabel(m)}</td>
                            {showFee && (
                              <td className="renew-fee">{feeLabel(m)}</td>
                            )}
                          </tr>
                          {/* Hàng phụ chiếm hết bề ngang: khối cách tính tự xuống dòng
                              được, không phải nhét vừa một cột. */}
                          {open && (
                            <tr>
                              <td
                                colSpan={showFee ? 4 : 3}
                                className="renew-calc-cell"
                              >
                                {renderCalc(m)}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              )}
              {/* Tổng GHIM đáy vùng cuộn, ngay dưới các dòng: chọn vài chục email thì
                  dòng tổng không bị đẩy khuất — người bán bấm nút là thấy số sắp bị
                  trừ. Tiền chỉ hiện ở ĐÚNG MỘT chỗ nên không có hai con số để đối
                  chiếu. */}
              {showFee && (
                <div className="renew-total">
                  <span className="renew-total-label">
                    {t("invite.feeDetailTotal")}
                    <em> · {t("renewals.selectedCount", { n: selectedRows.length })}</em>
                  </span>
                  <span className="renew-total-value">{totalLabel}</span>
                </div>
              )}
            </div>
            <div className="renew-modal-foot">
              {/* Chân popup CHỈ còn nút bấm. Tổng tiền đã nằm ở dải ghim ngay trên —
                  để thêm một bản sao ở đây thì hai chỗ có lúc lệch nhau. */}
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setShowBulkConfirm(false)}
                disabled={bulkRenew.isPending}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() =>
                  bulkRenew.mutate({ rows: selectedRows, months: bulkMonths })
                }
                disabled={bulkRenew.isPending || bulkMonths < 1}
              >
                {bulkRenew.isPending
                  ? t("common.loading")
                  : t("renewals.bulkRenewBtn", { n: selectedRows.length })}
              </button>
            </div>
          </div>
        </div>
      )}

      {qrOrder && (
        <OrderQrModal
          order={qrOrder}
          onClose={() => setQrOrder(null)}
          onPaid={() => {
            // BE đã chạy nốt lượt gia hạn của hoá đơn này → bỏ nó khỏi ô chọn rồi
            // trả về danh sách để bấm tiếp phần còn lại.
            setQrOrder(null);
            qc.invalidateQueries({ queryKey: ["added-members"] });
            qc.invalidateQueries({ queryKey: ["members"] });
          }}
        />
      )}

      {detailMember && (
        <MemberDetailModal
          workspaceId={detailMember.workspace_id}
          member={members.find((m) => m.id === detailMember.id) ?? detailMember}
          onClose={() => setDetailMember(null)}
        />
      )}
      {renewMember && (
        <ChangeSubscriptionModal
          workspaceId={renewMember.workspace_id}
          member={members.find((m) => m.id === renewMember.id) ?? renewMember}
          onClose={() => setRenewMember(null)}
          renew
        />
      )}
    </div>
  );
}

function RenewalRow({
  member,
  checked,
  onToggle,
  isSuper,
  t,
  formatDateTime,
  onOpenDetail,
  onRenew,
}: {
  member: AddedMember;
  checked: boolean;
  onToggle: () => void;
  isSuper: boolean;
  t: ReturnType<typeof useT>;
  formatDateTime: ReturnType<typeof useFormatDateTime>;
  onOpenDetail: (m: AddedMember) => void;
  onRenew: (m: AddedMember) => void;
}) {
  const endMs = new Date(member.subscription_end_at as string).getTime();
  const diffDays = Math.round((endMs - Date.now()) / DAY_MS);
  const expired = diffDays <= 0;
  // Màu khẩn: đã hết hạn / <3 ngày → đỏ; <7 ngày → vàng; còn xa → xám.
  const color = expired || diffDays < 3
    ? "var(--danger)"
    : diffDays < 7
      ? "var(--warning)"
      : "var(--ink-3)";
  const remainingLabel = expired
    ? t("member.subExpired", { n: -diffDays })
    : `(${t("member.subDaysLeftShort", { n: diffDays })})`;
  const renewAnchor =
    member.subscription_purchased_at ??
    member.last_invited_at ??
    member.created_at;

  return (
    <tr>
      <td style={{ textAlign: "center" }}>
        <input type="checkbox" checked={checked} onChange={onToggle} />
      </td>
      <td className="cell-email">
        <button
          type="button"
          className="cell-email-link"
          onClick={() => onOpenDetail(member)}
          title={t("memberDetail.openHint")}
        >
          {member.email}
        </button>
      </td>
      {isSuper && (
        <td className="cell-muted" style={{ fontSize: 12 }}>
          {member.invited_by_username ?? "—"}
        </td>
      )}
      <td className="cell-muted" style={{ fontSize: 13.5 }}>
        {fmtRenewExpiry(formatDateTime, renewAnchor)}
      </td>
      <td style={{ fontSize: 13.5, fontFamily: "var(--font-mono)" }}>
        {fmtRenewExpiry(formatDateTime, member.subscription_end_at as string)}
      </td>
      <td style={{ fontSize: 13.5, color, fontWeight: 600 }}>
        {remainingLabel}
      </td>
      <td style={{ textAlign: "right" }}>
        <button
          type="button"
          className="row-action"
          onClick={() => onRenew(member)}
          title={t("renewals.renewBtn")}
        >
          {t("renewals.renewBtn")}
        </button>
      </td>
    </tr>
  );
}

/** Thẻ gia hạn cho mobile — thay hàng bảng khi màn hẹp (không cuộn ngang 7 cột). */
function RenewalCard({
  member,
  checked,
  onToggle,
  isSuper,
  t,
  formatDateTime,
  onOpenDetail,
  onRenew,
}: {
  member: AddedMember;
  checked: boolean;
  onToggle: () => void;
  isSuper: boolean;
  t: ReturnType<typeof useT>;
  formatDateTime: ReturnType<typeof useFormatDateTime>;
  onOpenDetail: (m: AddedMember) => void;
  onRenew: (m: AddedMember) => void;
}) {
  const endMs = new Date(member.subscription_end_at as string).getTime();
  const diffDays = Math.round((endMs - Date.now()) / DAY_MS);
  const expired = diffDays <= 0;
  const color =
    expired || diffDays < 3
      ? "var(--danger)"
      : diffDays < 7
        ? "var(--warning)"
        : "var(--ink-3)";
  const remainingLabel = expired
    ? t("member.subExpired", { n: -diffDays })
    : `(${t("member.subDaysLeftShort", { n: diffDays })})`;
  const renewAnchor =
    member.subscription_purchased_at ??
    member.last_invited_at ??
    member.created_at;

  return (
    <div className="email-card">
      <div className="email-card-top">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          aria-label={member.email}
        />
        <button
          type="button"
          className="email-card-email"
          onClick={() => onOpenDetail(member)}
          title={t("memberDetail.openHint")}
        >
          {member.email}
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => onRenew(member)}
        >
          {t("renewals.renewBtn")}
        </button>
      </div>
      <div className="email-card-badges">
        <span style={{ fontSize: 12.5, color, fontWeight: 600 }}>
          {remainingLabel}
        </span>
        {isSuper && member.invited_by_username && (
          <span className="email-card-ws">{member.invited_by_username}</span>
        )}
      </div>
      <div className="email-card-dates">
        <div>
          <div className="email-card-date-label">
            {t("addedEmails.colRenewedAt")}
          </div>
          <div className="email-card-date-val">
            {fmtRenewExpiry(formatDateTime, renewAnchor)}
          </div>
        </div>
        <div>
          <div className="email-card-date-label">
            {t("addedEmails.colExpiry")}
          </div>
          <div className="email-card-date-val">
            {fmtRenewExpiry(formatDateTime, member.subscription_end_at as string)}
          </div>
        </div>
      </div>
    </div>
  );
}
