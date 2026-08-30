/**
 * Trang "Mời thành viên" — PHÍA NGƯỜI DÙNG (tính năng TEST, gate super-admin).
 *
 * Mô hình: mỗi người dùng được cấp 1 hoặc NHIỀU workspace đích (resolve qua
 * /api/v1/auto-invite/targets). Email đã từng tham gia (≥30 ngày, do chính user mời)
 * có thể chọn lại workspace cũ; email MỚI mặc định vào 1 workspace ngẫu nhiên trong
 * danh sách được cấp và (từ 2026-08-22) ĐỔI ĐƯỢC bằng dropdown ở cột "Không gian".
 *
 * Giao diện: theo mockup "Emerald Fresh" (2026-07-19) — card mời (ô dán email + bảng
 * preview với chip workspace, stepper tháng, ngày hết hạn) + cột phải task/lịch sử.
 * Logic mời/phí TÁI SỬ DỤNG bulk-invite; gom nhóm theo workspace đích khi dán trộn.
 */
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useFormatDate, useT, useTranslateEnum } from "../i18n";
import { useIsMobile } from "../hooks/useIsMobile";
import { useAuth } from "../hooks/useAuth";
import { parseEmailsFromText } from "../lib/emailParser";
import { useAutoInviteTargets, useEmailHistory } from "../hooks/useAutoInvite";
import { invalidateWorkspaceSeats, useSeatMap } from "../hooks/useWorkspaceSeats";
import InviteWorkspaceConfigModal from "../components/InviteWorkspaceConfigModal";
import { useExtensionStatus } from "../hooks/useExtensionTrigger";
import { queuePollInterval } from "../lib/queuePolling";
import { formatVnd, getQrOrder, type OrderQr } from "../lib/wallet";
import { toast } from "../components/Toast";
import type { Member, QueueItem } from "../types";
import OrderQrModal from "../components/OrderQrModal";

const DEFAULT_MONTHS = 1;
const MIN_MONTHS = 1;
const MAX_MONTHS = 60;
const QUICK_MONTHS = [1, 3, 6, 12] as const;
const DAYS_PER_MONTH = 30;

function clampMonths(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_MONTHS;
  return Math.max(MIN_MONTHS, Math.min(MAX_MONTHS, Math.floor(n)));
}

const monoLabel: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
};

// ─── Icon (inline SVG, kế thừa currentColor) ───
const ICON_PATHS: Record<string, string> = {
  check: '<path d="M4 12.5l5 5L20 6.5"/>',
  renew:
    '<path d="M4 12a8 8 0 0 1 13.7-5.7L20 8"/><path d="M20 3.5V8h-4.5"/><path d="M20 12a8 8 0 0 1-13.7 5.7L4 16"/><path d="M4 20.5V16h4.5"/>',
  cal: '<rect x="3.5" y="5" width="17" height="16" rx="2.2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2.2"/><path d="M3.6 6.6 12 12.8l8.4-6.2"/>',
};
function Icon({ name, size = 14 }: { name: keyof typeof ICON_PATHS; size?: number }) {
  return (
    <span
      style={{ display: "inline-flex", lineHeight: 0, flex: "none" }}
      dangerouslySetInnerHTML={{
        __html:
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" ` +
          `fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" ` +
          `stroke-linejoin="round">${ICON_PATHS[name] || ""}</svg>`,
      }}
    />
  );
}

function pillStyle(
  kind: "success" | "neutral" | "danger" | "warning",
): React.CSSProperties {
  const map = {
    success: { bg: "var(--success-bg)", fg: "var(--success)", bd: "transparent" },
    neutral: { bg: "var(--surface-2)", fg: "var(--ink-3)", bd: "var(--border)" },
    danger: { bg: "var(--danger-bg)", fg: "var(--danger)", bd: "transparent" },
    warning: { bg: "var(--warning-bg)", fg: "var(--warning)", bd: "transparent" },
  }[kind];
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    background: map.bg,
    color: map.fg,
    border: `1px solid ${map.bd}`,
    fontSize: 11.5,
    fontWeight: 600,
    padding: "4px 9px",
    borderRadius: 20,
    whiteSpace: "nowrap",
  };
}

const chipBase: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "4px 8px",
  background: "var(--surface)",
  maxWidth: "100%",
  minWidth: 0,
};
const wsDot: React.CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: "50%",
  background: "var(--success)",
  flex: "none",
};

export default function InviteMembers() {
  const t = useT();
  const formatDate = useFormatDate();
  const isMobile = useIsMobile();
  // Màn hình hẹp (desktop ≤1200, khớp lúc sidebar tự thu): ẩn nhãn trạng thái + ẩn
  // cột Không gian → chỉ còn Email · Số tháng · Hết hạn cho gọn.
  const compact = useIsMobile(1200);
  const qc = useQueryClient();

  const { user } = useAuth();
  const targets = useAutoInviteTargets();
  const eligibleWs = useMemo(
    () => targets.data?.workspaces ?? [],
    [targets.data],
  );
  // Workspace "chính" (cho ExtensionPill + invalidate) = phần tử đầu danh sách đích.
  const workspaceId = eligibleWs[0]?.workspace_id;
  const eligibleIds = useMemo(() => eligibleWs.map((w) => w.workspace_id), [eligibleWs]);
  // Đích NGẪU NHIÊN đã gán cho từng email MỚI (ổn định giữa các lần render nhờ ref).
  const randomWsRef = useRef<Record<string, string>>({});
  const [configOpen, setConfigOpen] = useState(false);

  const [emailsText, setEmailsText] = useState("");
  const [monthsByEmail, setMonthsByEmail] = useState<Record<string, number>>({});
  // Workspace ĐÍCH do user tự chọn ở cột "Không gian" (key = email lowercase) — áp cho
  // CẢ email cũ lẫn email mới. Vắng mặt → default lịch sử (email cũ) / đích cố định
  // hoặc ngẫu nhiên (email mới).
  const [workspaceByEmail, setWorkspaceByEmail] = useState<Record<string, string>>({});
  const [qrOrder, setQrOrder] = useState<OrderQr | null>(null);

  const { validUnique, validRaw, invalid, duplicates } = useMemo(
    () => parseEmailsFromText(emailsText),
    [emailsText],
  );
  const entries = useMemo(
    () =>
      validUnique.map((email, idx) => ({
        email,
        emailRaw: validRaw[idx] ?? email,
        months: monthsByEmail[email] ?? DEFAULT_MONTHS,
      })),
    [validUnique, validRaw, monthsByEmail],
  );
  const lineCount = useMemo(
    () => emailsText.split(/\r?\n/).filter((l) => l.trim()).length,
    [emailsText],
  );

  // Member hiện có (để gắn tag Gia hạn / Mời lại) — gộp TẤT CẢ workspace đích để tag
  // đúng khi email mới phân phối ngẫu nhiên / email active nằm ở ws đích khác.
  const { data: members = [] } = useQuery({
    queryKey: ["members", "invite-eligible", eligibleIds, "with-removed"],
    queryFn: async () => {
      const lists = await Promise.all(
        eligibleIds.map((ws) =>
          api<Member[]>(`/api/v1/workspaces/${ws}/members?include_removed=true`),
        ),
      );
      return lists.flat();
    },
    enabled: eligibleIds.length > 0,
  });
  const membersByEmail = useMemo(() => {
    const m = new Map<string, Member>();
    for (const x of members) m.set(x.email.toLowerCase(), x);
    return m;
  }, [members]);
  const nowMs = Date.now();
  const isRenew = (email: string) =>
    membersByEmail.get(email.toLowerCase())?.status === "active";
  const renewCount = entries.filter((e) => isRenew(e.email)).length;

  // Lịch sử workspace của email đã từng tham gia (≥30 ngày, do chính user này mời).
  const emailHistory = useEmailHistory(validUnique);
  const historyMap = emailHistory.data ?? {};
  const historyFor = (email: string) => historyMap[email.toLowerCase()];
  /** Workspace ĐÍCH của 1 email. Email cũ (có lịch sử): user chọn > default lịch sử.
   * Email MỚI: 1 workspace đích, user chọn (nếu được cấp ≥2), ngược lại NGẪU NHIÊN
   * (ổn định theo email nhờ ref). */
  const targetWsId = (email: string): string | undefined => {
    const key = email.toLowerCase();
    const picked = workspaceByEmail[key];
    const h = historyFor(email);
    if (h) return picked ?? h.default_workspace_id;
    if (eligibleIds.length <= 1) return eligibleIds[0];
    // Email mới nhưng user đã tự chọn không gian ở cột "Không gian" → tôn trọng.
    if (picked && eligibleIds.includes(picked)) return picked;
    const prev = randomWsRef.current[key];
    if (!prev || !eligibleIds.includes(prev)) {
      randomWsRef.current[key] =
        eligibleIds[Math.floor(Math.random() * eligibleIds.length)];
    }
    return randomWsRef.current[key];
  };
  /** Không gian CHỌN ĐƯỢC cho 1 email (dùng chung desktop + mobile):
   * - email CŨ (có lịch sử): các workspace lịch sử — giữ nguyên ý nghĩa "chọn lại
   *   không gian cũ" (kèm usageDays để hiện "đã dùng X tháng" ở tooltip);
   * - email MỚI: toàn bộ workspace đích được cấp → user đổi được thay vì chịu bản
   *   ngẫu nhiên (yêu cầu user 2026-08-22).
   * ≥2 phần tử thì UI hiện dropdown, 1 phần tử hiện chữ tĩnh. */
  const wsOptionsFor = (
    email: string,
  ): { id: string; name: string; usageDays?: number }[] => {
    const h = historyFor(email);
    if (h)
      return h.workspaces.map((w) => ({
        id: w.workspace_id,
        name: w.name,
        usageDays: w.usage_days,
      }));
    return eligibleWs.map((w) => ({ id: w.workspace_id, name: w.name }));
  };

  // Dự tính phí THẬT từ server. Footer trước đây hard-code 0đ nên "Tổng phí" luôn
  // hiện 0 dù có tính phí. Gom email theo workspace đích rồi gọi /invite-preview mỗi
  // nhóm (mirror lúc mời), cộng total_fee. plan_invite_fees lo 2 tầng phí +
  // miễn-phí còn-hạn/chuyển-ws + số tháng — không suy được ở client.
  //
  // Lấy LUÔN `free_emails` của cùng lời gọi đó để đếm miễn-phí/tính-phí (xem `isFree`
  // ngay dưới) — cùng một nguồn với `total_fee` nên nhãn và số tiền không thể lệch nhau.
  const feePreviewInput = entries
    .map((e) => ({ email: e.email, months: e.months, ws: targetWsId(e.email) }))
    .filter((x): x is { email: string; months: number; ws: string } => !!x.ws);
  const feePreview = useQuery({
    queryKey: ["invite-fee-preview", feePreviewInput],
    enabled: feePreviewInput.length > 0,
    queryFn: async () => {
      const groups = new Map<
        string,
        { email: string; subscription_months: number }[]
      >();
      for (const x of feePreviewInput) {
        const arr = groups.get(x.ws) ?? [];
        arr.push({ email: x.email, subscription_months: x.months });
        groups.set(x.ws, arr);
      }
      let total = 0;
      const free = new Set<string>();
      for (const [ws, invites] of groups) {
        const r = await api<{ total_fee: number; free_emails: string[] }>(
          `/api/v1/workspaces/${ws}/members/invite-preview`,
          { method: "POST", body: JSON.stringify({ invites, role: "member" }) },
        );
        total += r.total_fee;
        for (const e of r.free_emails ?? []) free.add(e.toLowerCase());
      }
      return { total, free };
    },
  });

  // MIỄN PHÍ do SERVER chốt (`free_emails` ở trên), KHÔNG tự suy ở client: luật miễn phí
  // gồm cả member `pending` còn hạn (BE 2026-08-26) lẫn gói còn hạn nằm ở workspace KHÁC
  // (chuyển/hợp nhất ws) — hai ca mà danh sách member đang tải ở đây không nhìn thấy.
  // Luật cũ (chỉ `removed` trong ws đã tải) làm footer ghi "1 tính phí" ngay cạnh
  // "Tổng phí: 0 đ" — cùng một lời mời, hai câu trả lời ngược nhau (user 2026-08-27).
  // Chưa có kết quả preview (đang tải/lỗi) → tạm dùng luật cũ cho khỏi trống nhãn.
  const isFree = (email: string) => {
    const srv = feePreview.data?.free;
    if (srv) return srv.has(email.toLowerCase());
    const m = membersByEmail.get(email.toLowerCase());
    return (
      m?.status === "removed" &&
      !!m.subscription_end_at &&
      new Date(m.subscription_end_at).getTime() > nowMs
    );
  };
  const freeCount = entries.filter((e) => isFree(e.email)).length;
  const chargedCount = entries.length - freeCount;

  function removeEmailsFromText(emailsLower: Set<string>) {
    setEmailsText((text) =>
      text
        .split(/\r?\n/)
        .map((line) => {
          const tokens = line.split(/[,;]/).map((s) => s.trim());
          const kept = tokens.filter((tok) => !emailsLower.has(tok.toLowerCase()));
          return kept.length === tokens.length ? line : kept.join(", ");
        })
        .filter((line) => line.trim() !== "")
        .join("\n"),
    );
  }

  // Mời hàng loạt — GOM NHÓM theo workspace đích rồi gọi mời từng nhóm (cho phép 1 lần
  // dán trộn nhiều workspace). Logic mời + thanh toán mỗi nhóm giữ nguyên như bulk-invite
  // sẵn có; email cũ mua lại tính phí như mời mới. 402 (ví thiếu) → mở QR cho nhóm đó.
  const bulkInvite = useMutation({
    mutationFn: async () => {
      const groups = new Map<string, { email: string; subscription_months: number }[]>();
      for (const e of entries) {
        const ws = targetWsId(e.email);
        if (!ws) continue;
        const arr = groups.get(ws) ?? [];
        arr.push({ email: e.email, subscription_months: e.months });
        groups.set(ws, arr);
      }
      let invited = 0;
      let renewed = 0;
      const queued: string[] = [];
      let order: OrderQr | null = null;
      // Nhóm gửi hỏng KHÔNG được làm hỏng cả mẻ: trước 2026-08-30 nhánh này ném
      // thẳng, nên nhóm 1 đã mời xong và đã trừ tiền mà toast chỉ hiện lỗi của
      // nhóm 2 — người dùng tưởng cả mẻ trượt rồi dán lại. Hay gặp từ khi có hạn
      // mức thao tác: nhóm sau dính cooldown là chuyện bình thường.
      const failures: { ws: string; message: string }[] = [];
      for (const [ws, invites] of groups) {
        try {
          const resp = await api<{
            count: number;
            invited_count?: number;
            renewed_count?: number;
          }>(`/api/v1/workspaces/${ws}/members/bulk-invite`, {
            method: "POST",
            body: JSON.stringify({ invites, role: "member" }),
          });
          invited += resp.invited_count ?? resp.count;
          renewed += resp.renewed_count ?? 0;
          for (const i of invites) queued.push(i.email);
        } catch (err) {
          const o = getQrOrder(err);
          if (o) {
            order = o;
            break; // dừng ở nhóm cần thanh toán; các nhóm sau để user xử lý lại
          }
          failures.push({
            ws,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return { invited, renewed, queued, order, failures };
    },
    onSuccess: ({ invited, renewed, queued, order, failures }) => {
      if (queued.length) {
        const set = new Set(queued.map((e) => e.toLowerCase()));
        removeEmailsFromText(set);
        setMonthsByEmail((m) => {
          const next = { ...m };
          for (const e of set) delete next[e];
          return next;
        });
        setWorkspaceByEmail((w) => {
          const next = { ...w };
          for (const e of set) delete next[e];
          return next;
        });
      }
      if (invited > 0 && renewed > 0)
        toast.success(t("invite.resultMixed", { invited, renewed }));
      else if (renewed > 0) toast.success(t("invite.resultRenewed", { n: renewed }));
      else if (invited > 0) toast.success(t("invite.resultQueued", { n: invited }));
      qc.invalidateQueries({ queryKey: ["invite-queue", workspaceId] });
      qc.invalidateQueries({ queryKey: ["members", workspaceId, "with-removed"] });
      // Vừa mời xong = suất trống vừa đổi → kéo lại ngay, đừng bắt người dùng nhìn
      // con số cũ tới hết nhịp tim 15s.
      invalidateWorkspaceSeats(qc);
      if (order) setQrOrder(order);
      // Gom theo LÝ DO: nhiều workspace thường trượt vì cùng một lý do, báo từng
      // dòng một là chôn mất thông báo thành công phía trên.
      if (failures.length) {
        const byReason = new Map<string, string[]>();
        for (const f of failures) {
          const name =
            eligibleWs.find((w) => w.workspace_id === f.ws)?.name ?? f.ws;
          byReason.set(f.message, [...(byReason.get(f.message) ?? []), name]);
        }
        for (const [reason, names] of byReason) {
          toast.error(
            t("invite.groupsFailed", { names: names.join(", "), reason }),
          );
        }
      }
    },
    onError: (e) => {
      const msg =
        e instanceof ApiError
          ? typeof e.detail === "object" && e.detail
            ? String((e.detail as { message?: string }).message ?? JSON.stringify(e.detail))
            : String(e.detail)
          : e instanceof Error
            ? e.message
            : String(e);
      toast.error(msg);
    },
  });

  function setMonthsFor(email: string, months: number) {
    setMonthsByEmail((m) => ({ ...m, [email]: clampMonths(months) }));
  }
  function applyMonthsToAll(months: number) {
    setMonthsByEmail(() => {
      const next: Record<string, number> = {};
      for (const email of validUnique) next[email] = clampMonths(months);
      return next;
    });
  }
  function removeEntry(emailLower: string) {
    setEmailsText((text) => {
      const lines = text.split(/\r?\n/);
      const kept: string[] = [];
      for (const line of lines) {
        const tokens = line.split(/[,;]/).map((s) => s.trim());
        const keptTokens = tokens.filter((tok) => tok.toLowerCase() !== emailLower);
        if (keptTokens.length === tokens.length) kept.push(line);
        else if (keptTokens.length > 0) kept.push(keptTokens.join(", "));
      }
      return kept.join("\n");
    });
    setMonthsByEmail((m) => {
      const next = { ...m };
      delete next[emailLower];
      return next;
    });
    setWorkspaceByEmail((w) => {
      const next = { ...w };
      delete next[emailLower];
      return next;
    });
  }
  const formatExpiresDate = (months: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + months * DAYS_PER_MONTH);
    return formatDate(d, { day: "numeric", month: "short", year: "numeric" });
  };
  const formatRenewExpiry = (email: string, months: number) => {
    const m = membersByEmail.get(email.toLowerCase());
    const end = m?.subscription_end_at ? new Date(m.subscription_end_at) : null;
    const base = end && end.getTime() > nowMs ? end : new Date();
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + months * DAYS_PER_MONTH);
    return formatDate(d, { day: "numeric", month: "short", year: "numeric" });
  };
  // Email mời-lại còn hạn (miễn phí): cột Hết hạn chỉ hiện NGÀY còn hạn hiện tại.
  const formatFreeExpiry = (email: string) => {
    const end = membersByEmail.get(email.toLowerCase())?.subscription_end_at;
    return end
      ? formatDate(new Date(end), { day: "numeric", month: "short", year: "numeric" })
      : "—";
  };

  const rowCols = isMobile
    ? "minmax(0,1fr) 118px 96px 92px 24px"
    : compact
      ? // Rất hẹp: ẩn cột Không gian → chỉ Email · Số tháng · Hết hạn (+ xoá).
        "minmax(max-content,2fr) minmax(92px,1fr) minmax(110px,1.1fr) 28px"
      : "minmax(max-content,1.4fr) minmax(0,0.85fr) minmax(96px,1fr) minmax(112px,1.05fr) 28px";
  const usedText = (days: number) => {
    const months = Math.floor(days / DAYS_PER_MONTH);
    return months >= 1
      ? t("inviteMembers.wsUsedMonths", { n: months })
      : t("inviteMembers.wsUsedDays", { n: days });
  };
  /**
   * Suất còn trống của từng không gian — nguồn DÙNG CHUNG `useWorkspaceSeats`
   * (poll 15s + invalidate sau mỗi hành động), KHÔNG lấy `seat_used` kèm trong
   * `/auto-invite/targets` vì danh sách đích cache 5′ nên số suất ở đó thiu.
   */
  const { seatMap } = useSeatMap();
  /**
   * Danh sách đang dán CẦN bao nhiêu suất MỚI ở mỗi không gian, và còn bao nhiêu.
   *
   * "Suất mới" = email chưa giữ suất nào ở ĐÚNG không gian đích đó. Email đang là
   * thành viên (`active`) hay đang chờ nhận lời mời (`pending`) ở chính không gian
   * đó đã nằm trong `seat_used` rồi — đếm thêm là báo thiếu suất oan, người dùng
   * tưởng sắp bị mua thêm suất bằng tiền thật. Mirror `_count_new_invite_seats` +
   * cách đếm `seat_used` của backend.
   */
  const seatPlan = (() => {
    // Tra theo CẶP (email, workspace) chứ không qua `membersByEmail` (khoá chỉ có
    // email, nhiều workspace đè lên nhau): một email có bản ghi `removed` ở ws này
    // và bản ghi đang sống ở ws kia là chuyện thường.
    const holders = new Set(
      members
        .filter((m) => m.status !== "removed")
        .map((m) => `${m.email.toLowerCase()}|${m.workspace_id}`),
    );
    const need = new Map<string, number>();
    for (const e of entries) {
      const ws = targetWsId(e.email);
      if (!ws) continue;
      if (!holders.has(`${e.email.toLowerCase()}|${ws}`))
        need.set(ws, (need.get(ws) ?? 0) + 1);
    }
    return need;
  })();
  /** Suất của 1 không gian + phần thiếu so với danh sách đang dán.
   * `left = null` ⇒ chưa từng đồng bộ tổng suất → KHÔNG kết luận thiếu/đủ. */
  const seatInfo = (wsId: string | undefined) => {
    const row = wsId ? seatMap.get(wsId) : undefined;
    const left = row?.seat_left ?? null;
    const need = wsId ? (seatPlan.get(wsId) ?? 0) : 0;
    return {
      left,
      need,
      short: left === null ? 0 : Math.max(need - left, 0),
      // Số suất còn lại SAU KHI mời hết danh sách đang dán — đây mới là con số
      // người dùng cần: dán thêm 1 email là thấy nó tụt đi 1, dán quá tay thì về 0
      // kèm phần thiếu. `left` thô chỉ dùng cho tooltip giải thích.
      after: left === null ? null : Math.max(left - need, 0),
    };
  };
  /** Nhãn suất cạnh tên không gian: "còn 4" / "hết suất" / "" khi chưa biết tổng. */
  const seatLabel = (wsId: string | undefined) => {
    const { after } = seatInfo(wsId);
    if (after === null) return "";
    return after > 0 ? t("inviteMembers.seatsLeft", { n: after }) : t("inviteMembers.seatsNone");
  };
  /**
   * Không gian hiện trên DẢI SUẤT ở đầu thẻ: mọi đích được cấp + đích của email cũ
   * (lịch sử) nếu nằm ngoài danh sách cấp — nếu không, dán một email cũ vào là dải
   * suất im lặng bỏ qua đúng cái không gian sắp bị trừ suất.
   */
  const seatBarWs = (() => {
    const ids = eligibleWs.map((w) => w.workspace_id);
    for (const id of seatPlan.keys()) if (!ids.includes(id)) ids.push(id);
    return ids.map((id) => ({
      id,
      name:
        seatMap.get(id)?.name ??
        eligibleWs.find((w) => w.workspace_id === id)?.name ??
        "—",
    }));
  })();
  /** Không gian ĐANG có vấn đề: hết suất, hoặc danh sách đang dán cần nhiều hơn số
   * suất còn trống (mời tiếp là extension đi mua thêm suất bằng tiền thật). Chỉ chỗ
   * này mới được tô đỏ — còn lại giữ đơn sắc cho đỡ rối. */
  const seatAlarm = (wsId: string | undefined) => {
    const { after } = seatInfo(wsId);
    return after === 0;
  };

  /** Tổng suất phải MUA THÊM trên ChatGPT nếu bấm mời ngay bây giờ (cộng mọi không
   * gian trong danh sách đang dán). >0 nghĩa là lệnh mời sẽ kèm bước mua suất, chạy
   * lâu hơn hẳn — footer phải nói trước. */
  const seatToBuy = [...seatPlan.keys()].reduce((n, wsId) => n + seatInfo(wsId).short, 0);

  const canSubmit = !!workspaceId && entries.length > 0 && !bulkInvite.isPending;

  return (
    <div className="page-fade">
      {qrOrder && (
        <OrderQrModal
          order={qrOrder}
          onClose={() => setQrOrder(null)}
          onPaid={() => {
            setQrOrder(null);
            setEmailsText("");
            setMonthsByEmail({});
            setWorkspaceByEmail({});
            qc.invalidateQueries({ queryKey: ["invite-queue", workspaceId] });
            invalidateWorkspaceSeats(qc);
          }}
        />
      )}

      {configOpen && (
        <InviteWorkspaceConfigModal
          onClose={() => {
            setConfigOpen(false);
            // Cấu hình đích có thể đổi → làm mới danh sách workspace đích của mình.
            qc.invalidateQueries({ queryKey: ["auto-invite-targets"] });
          }}
        />
      )}

      {/* Vùng nội dung — thu nhỏ ~10% cho gọn chữ toàn trang (modal không bị ảnh hưởng). */}
      <div style={{ zoom: 0.9 }}>
      {/* Thanh trên: nút cấu hình đích (⚙️, super-admin) + trạng thái extension. */}
      {(user?.is_super_admin || workspaceId) && (
        <div
          className="flex items-center justify-end"
          style={{ marginBottom: 16, gap: 8 }}
        >
          {user?.is_super_admin && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setConfigOpen(true)}
              title={t("inviteConfig.openTitle")}
            >
              ⚙️ {t("inviteConfig.openLabel")}
            </button>
          )}
          {workspaceId && <ExtensionPill workspaceId={workspaceId} />}
        </div>
      )}

      {!targets.isLoading && eligibleWs.length === 0 ? (
        <div
          className="surface-card"
          style={{ padding: 24, color: "var(--ink-2)", maxWidth: 560 }}
        >
          {t("inviteMembers.noTarget")}
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            gap: 20,
            alignItems: isMobile ? "flex-start" : "stretch",
            // Cho panel Task xuống dòng dưới card khi không đủ bề ngang (thay vì ép
            // card thu nhỏ tới mức tràn/cắt nội dung).
            flexWrap: "wrap",
          }}
        >
          {/* CỘT TRÁI — thẻ mời */}
          <div
            style={{
              // Basis rộng: panel Task xuống dòng dưới card trên màn hình vừa (laptop)
              // để bảng preview đủ chỗ hiển thị đủ email/workspace; chỉ nằm cạnh nhau
              // khi màn hình thật rộng.
              flex: "1 1 860px",
              minWidth: 0,
              width: isMobile ? "100%" : "auto",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-lg)",
              boxShadow: "var(--shadow-card)",
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
          >
            {/* header */}
            <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)" }}>
              <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em" }}>
                {t("invite.modalTitle")}
              </div>
              {/* KHÔNG chặn bề ngang: để câu phụ đề tự xuống dòng theo bề ngang thẻ.
                  `maxWidth: 660` cũ làm nó luôn gãy giữa câu dù thẻ còn thừa chỗ. */}
              <div
                style={{
                  fontSize: 12.5,
                  color: "var(--ink-3)",
                  marginTop: 3,
                  lineHeight: 1.45,
                }}
              >
                {t("inviteMembers.cardSubtitle")}
              </div>

            </div>

            {/* DẢI SUẤT — mỗi không gian một khối số kiểu thẻ tổng quan: nhãn mono +
                số suất CÒN LẠI SAU KHI mời hết danh sách đang dán (dán thêm email là
                thấy nó tụt), không kể đã dùng bao nhiêu. Đơn sắc cho đỡ rối, chỉ đỏ
                khi hết sạch suất. Nguồn
                `useWorkspaceSeats` (poll 15s) nên số tự nhảy khi extension mời/xoá
                hay admin khác thao tác ở tab kia. */}
            {seatBarWs.length > 0 && (
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  rowGap: 14,
                  padding: "14px 20px 15px",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                {seatBarWs.map((w, i) => {
                  const { left, need, short, after } = seatInfo(w.id);
                  const alarm = seatAlarm(w.id);
                  return (
                    <div
                      key={w.id}
                      title={
                        left === null
                          ? t("inviteMembers.seatsUnknownHint")
                          : t("inviteMembers.seatsHint", { left, need })
                      }
                      style={{
                        minWidth: 118,
                        paddingLeft: i === 0 ? 0 : 20,
                        marginLeft: i === 0 ? 0 : 20,
                        borderLeft: i === 0 ? "none" : "1px solid var(--border)",
                      }}
                    >
                      <div
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: 10,
                          textTransform: "uppercase",
                          letterSpacing: "0.06em",
                          color: "var(--ink-3)",
                          maxWidth: 190,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {w.name}
                      </div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "baseline",
                          gap: 6,
                          marginTop: 7,
                        }}
                      >
                        <span
                          style={{
                            fontFamily: "var(--font-display)",
                            fontSize: 26,
                            fontWeight: 700,
                            letterSpacing: "-0.03em",
                            lineHeight: 1,
                            color: alarm ? "var(--danger)" : "var(--ink)",
                          }}
                        >
                          {after === null ? "—" : after}
                        </span>
                        <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                          {t("inviteMembers.seatFreeWord")}
                        </span>
                      </div>
                      {/* Chỉ dòng phụ khi CẦN nói thêm: danh sách đang dán cần bao
                          nhiêu suất, hoặc lý do con số trống rỗng. Không kể "đã dùng
                          x/y" — người dùng chỉ cần biết còn lại mấy suất. */}
                      {(need > 0 || left === null) && (
                        <div
                          style={{
                            marginTop: 7,
                            fontFamily: "var(--font-mono)",
                            fontSize: 10.5,
                            whiteSpace: "nowrap",
                            fontWeight: need > 0 ? 600 : 400,
                            color:
                              short > 0
                                ? "var(--danger)"
                                : need > 0
                                  ? "var(--ink-2)"
                                  : "var(--ink-3)",
                          }}
                        >
                          {left === null
                            ? t("inviteMembers.seatTotalUnknown")
                            : short > 0
                              ? t("inviteMembers.seatShortN", { n: short })
                              : t("inviteMembers.seatNeedN", { n: need })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* body 2 cột */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: isMobile ? "1fr" : "260px minmax(0,1fr)",
                flex: 1,
                minHeight: 320,
              }}
            >
              {/* trái: ô dán email */}
              <div
                style={{
                  borderRight: isMobile ? "none" : "1px solid var(--border)",
                  borderBottom: isMobile ? "1px solid var(--border)" : "none",
                  padding: 16,
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                  minHeight: 0,
                }}
              >
                <label style={monoLabel}>{t("invite.pasteLabelShort")}</label>
                <textarea
                  value={emailsText}
                  onChange={(e) => setEmailsText(e.target.value)}
                  placeholder={"email1@gmail.com\nemail2@gmail.com, email3@gmail.com"}
                  disabled={bulkInvite.isPending}
                  spellCheck={false}
                  style={{
                    flex: 1,
                    minHeight: 190,
                    resize: "none",
                    border: "1px solid var(--border)",
                    borderRadius: 9,
                    padding: "11px 12px",
                    fontFamily: "var(--font-mono)",
                    fontSize: 13,
                    lineHeight: 1.7,
                    color: "var(--ink)",
                    background: "var(--surface-2)",
                    outline: "none",
                  }}
                />
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    flexWrap: "wrap",
                  }}
                >
                  <span style={pillStyle("success")}>
                    <Icon name="check" size={13} />
                    {t("invite.parsed", { n: entries.length })}
                  </span>
                  {renewCount > 0 && (
                    <span style={pillStyle("neutral")}>
                      <Icon name="renew" size={12} />
                      {t("invite.renewCount", { n: renewCount })}
                    </span>
                  )}
                  {invalid.length > 0 && (
                    <span style={pillStyle("danger")}>
                      {t("invite.invalidFormat", { n: invalid.length })}
                    </span>
                  )}
                  {duplicates.length > 0 && (
                    <span style={pillStyle("warning")}>
                      {t("invite.duplicateSkipped", { n: duplicates.length })}
                    </span>
                  )}
                  <span
                    style={{
                      marginLeft: "auto",
                      color: "var(--ink-3)",
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                    }}
                  >
                    {t("inviteMembers.lineCount", { n: lineCount })}
                  </span>
                </div>

                {entries.length > 0 && (
                  <div
                    style={{
                      border: "1px solid var(--border)",
                      borderRadius: 9,
                      padding: "10px 12px",
                      background: "var(--surface-2)",
                    }}
                  >
                    <div
                      style={{ fontSize: 11.5, color: "var(--ink-3)", marginBottom: 9 }}
                    >
                      {t("invite.applyToAll")}:
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      {QUICK_MONTHS.map((m) => (
                        <button
                          key={m}
                          onClick={() => applyMonthsToAll(m)}
                          disabled={bulkInvite.isPending}
                          style={{
                            flex: "1 1 0",
                            minWidth: 0,
                            border: "1px solid var(--border)",
                            background: "var(--surface)",
                            color: "var(--ink)",
                            borderRadius: 7,
                            padding: "6px 4px",
                            fontSize: 12,
                            fontWeight: 500,
                            fontFamily: "var(--font-mono)",
                            cursor: "pointer",
                          }}
                        >
                          {m}
                          {t("invite.monthsShort")}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* phải: bảng preview (desktop) / danh sách thẻ (mobile) */}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  minHeight: 0,
                  minWidth: 0,
                }}
              >
                {/* Một vùng cuộn duy nhất: cuộn NGANG khi hẹp (không cắt nội dung) +
                    cuộn dọc khi nhiều dòng. Header + hàng nằm chung nên luôn thẳng cột. */}
                <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
                  <div
                    style={
                      isMobile
                        ? entries.length > 0
                          ? { padding: 12, display: "flex", flexDirection: "column", gap: 10 }
                          : {}
                        : entries.length > 0
                          ? { minWidth: 360, maxWidth: 900 }
                          : {}
                    }
                  >
                    {!isMobile && entries.length > 0 && (
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: rowCols,
                          columnGap: 12,
                          padding: "12px 18px",
                          borderBottom: "1px solid var(--border)",
                          position: "sticky",
                          top: 0,
                          zIndex: 1,
                          background: "var(--surface)",
                          whiteSpace: "nowrap",
                          ...monoLabel,
                        }}
                      >
                        <span>{t("invite.colEmail")}</span>
                        {!compact && <span>{t("inviteMembers.colWorkspace")}</span>}
                        <span>{t("invite.colMonths")}</span>
                        <span>{t("invite.colExpires")}</span>
                        <span></span>
                      </div>
                    )}
                    {entries.length === 0 ? (
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 8,
                        color: "var(--ink-3)",
                        padding: "48px 20px",
                        textAlign: "center",
                        minHeight: 180,
                      }}
                    >
                      <span style={{ opacity: 0.5 }}>
                        <Icon name="mail" size={26} />
                      </span>
                      <div style={{ fontSize: 15, fontWeight: 600, color: "var(--ink-2)" }}>
                        {t("invite.emptyTitle")}
                      </div>
                      <div style={{ fontSize: 13, maxWidth: 320, lineHeight: 1.5 }}>
                        {t("invite.emptyDesc")}
                      </div>
                    </div>
                  ) : (
                    entries.map((row) => {
                      const renew = isRenew(row.email);
                      const free = isFree(row.email);
                      // Không gian ĐANG chọn = đúng đích sẽ mời (user chọn > default
                      // lịch sử > đích cố định/ngẫu nhiên) → select luôn khớp đích thật.
                      const selectedWs = targetWsId(row.email);

                      // ── MOBILE: thẻ dọc (theo mockup Mời-thành-viên) ──
                      if (isMobile) {
                        return (
                          <MobileInviteCard
                            key={row.email}
                            row={row}
                            renew={renew}
                            free={free}
                            wsOptions={wsOptionsFor(row.email)}
                            selectedWs={selectedWs}
                            busy={bulkInvite.isPending}
                            usedText={usedText}
                            seatLabel={seatLabel}
                            seatAlarm={seatAlarm(selectedWs)}
                            onWs={(v) =>
                              setWorkspaceByEmail((w) => ({
                                ...w,
                                [row.email.toLowerCase()]: v,
                              }))
                            }
                            onDec={() => setMonthsFor(row.email, row.months - 1)}
                            onInc={() => setMonthsFor(row.email, row.months + 1)}
                            onRemove={() => removeEntry(row.email)}
                            expiry={
                              renew
                                ? formatRenewExpiry(row.email, row.months)
                                : free
                                  ? formatFreeExpiry(row.email)
                                  : formatExpiresDate(row.months)
                            }
                            expiryFree={free}
                            t={t}
                          />
                        );
                      }

                      // ── DESKTOP: hàng bảng (grid) ──
                      return (
                        <div
                          key={row.email}
                          style={{
                            display: "grid",
                            gridTemplateColumns: rowCols,
                            columnGap: 12,
                            padding: "11px 18px",
                            borderBottom: "1px solid var(--border)",
                            alignItems: "center",
                          }}
                        >
                          {/* email + tag trạng thái */}
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              minWidth: 0,
                            }}
                          >
                            <span
                              title={row.emailRaw}
                              style={{
                                // flex 0 1 auto: email + nhãn NẰM LIỀN nhau (không để
                                // flex:1 đẩy nhãn ra xa tạo khoảng trống giữa cột).
                                flex: "0 1 auto",
                                minWidth: 0,
                                fontSize: 13,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {row.emailRaw}
                            </span>
                            {/* Nhãn trạng thái ẩn khi màn hình hẹp để cột email luôn
                                hiện đủ (bất biến); trạng thái vẫn thấy ở cột Hết hạn. */}
                            {compact ? null : renew ? (
                              <span style={tagStyle("accent")}>↻ {t("invite.tagRenew")}</span>
                            ) : free ? (
                              <span style={tagStyle("success")}>✓ {t("invite.tagReinvite")}</span>
                            ) : null}
                          </div>

                          {/* workspace: chip + select (khi có ≥2 lựa chọn) / chữ
                              tĩnh. Hiện tên không gian + SUẤT CÒN TRỐNG (để biết
                              trước khi add); "đã dùng X tháng" (email cũ) ở tooltip.
                              Ẩn hẳn cột khi màn hình rất hẹp (compact). */}
                          {!compact &&
                            (() => {
                              const opts = wsOptionsFor(row.email);
                              const sel = opts.find((o) => o.id === selectedWs);
                              const info = seatInfo(selectedWs);
                              const seatText = seatLabel(selectedWs);
                              const seatTitle =
                                info.left === null
                                  ? t("inviteMembers.seatsUnknownHint")
                                  : t("inviteMembers.seatsHint", {
                                      left: info.left,
                                      need: info.need,
                                    });
                              const selTitle =
                                (sel === undefined
                                  ? t("inviteMembers.colWorkspace")
                                  : sel.usageDays === undefined
                                    ? sel.name
                                    : t("inviteMembers.wsOption", {
                                        name: sel.name,
                                        used: usedText(sel.usageDays),
                                      })) +
                                " · " +
                                seatTitle;
                              // Suất trống KHÔNG đủ cho danh sách đang dán → nhãn đỏ:
                              // mời tiếp là extension đi mua thêm suất bằng tiền thật.
                              const alarm = seatAlarm(selectedWs);
                              const seatBadge = seatText ? (
                                <span
                                  style={{
                                    flex: "none",
                                    fontFamily: "var(--font-mono)",
                                    fontSize: 11.5,
                                    fontWeight: 600,
                                    padding: "1px 6px",
                                    borderRadius: 5,
                                    background: alarm ? "var(--danger-bg)" : "var(--surface-2)",
                                    color: alarm ? "var(--danger)" : "var(--ink-2)",
                                  }}
                                >
                                  {seatText}
                                </span>
                              ) : null;
                              // Chỉ 1 không gian khả dĩ → chữ tĩnh (không dropdown
                              // rườm rà). ≥2 mới cho chọn bằng select.
                              if (opts.length <= 1) {
                                return (
                                  <div style={chipBase} title={selTitle}>
                                    <span style={wsDot} />
                                    <span
                                      style={{
                                        fontSize: 12.5,
                                        color: "var(--ink)",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        whiteSpace: "nowrap",
                                      }}
                                    >
                                      {sel?.name ?? opts[0]?.name ?? "—"}
                                    </span>
                                    {seatBadge}
                                  </div>
                                );
                              }
                              return (
                                <div style={chipBase} title={selTitle}>
                                  <span style={wsDot} />
                                  <select
                                    value={selectedWs ?? ""}
                                    onChange={(e) =>
                                      setWorkspaceByEmail((w) => ({
                                        ...w,
                                        [row.email.toLowerCase()]: e.target.value,
                                      }))
                                    }
                                    disabled={bulkInvite.isPending}
                                    title={selTitle}
                                    style={{
                                      border: "none",
                                      background: "transparent",
                                      fontFamily: "var(--font-sans)",
                                      fontSize: 12.5,
                                      color: "var(--ink)",
                                      outline: "none",
                                      cursor: "pointer",
                                      minWidth: 0,
                                      width: "fit-content",
                                      maxWidth: 150,
                                      WebkitAppearance: "none",
                                      appearance: "none",
                                    }}
                                  >
                                    {opts.map((o) => (
                                      <option
                                        key={o.id}
                                        value={o.id}
                                        title={
                                          o.usageDays === undefined
                                            ? undefined
                                            : usedText(o.usageDays)
                                        }
                                      >
                                        {/* Suất trống ngay trong lựa chọn: đổi không
                                            gian là biết ngay chỗ nào còn chỗ. */}
                                        {seatLabel(o.id)
                                          ? `${o.name} · ${seatLabel(o.id)}`
                                          : o.name}
                                      </option>
                                    ))}
                                  </select>
                                  <span style={{ color: "var(--ink-3)", fontSize: 9 }}>▾</span>
                                  {seatBadge}
                                </div>
                              );
                            })()}

                          {/* stepper số tháng (nhóm nối liền) */}
                          <div
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              border: "1px solid var(--border)",
                              borderRadius: 8,
                              overflow: "hidden",
                              width: "fit-content",
                            }}
                          >
                            <button
                              onClick={() => setMonthsFor(row.email, row.months - 1)}
                              disabled={bulkInvite.isPending || row.months <= MIN_MONTHS}
                              style={stepBtn}
                            >
                              −
                            </button>
                            <div
                              style={{
                                width: 32,
                                textAlign: "center",
                                fontSize: 13,
                                fontWeight: 500,
                                fontFamily: "var(--font-mono)",
                                borderLeft: "1px solid var(--border)",
                                borderRight: "1px solid var(--border)",
                                lineHeight: "28px",
                              }}
                            >
                              {row.months}
                            </div>
                            <button
                              onClick={() => setMonthsFor(row.email, row.months + 1)}
                              disabled={bulkInvite.isPending || row.months >= MAX_MONTHS}
                              style={stepBtn}
                            >
                              +
                            </button>
                          </div>

                          {/* hết hạn */}
                          {renew ? (
                            <div
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 6,
                                fontFamily: "var(--font-mono)",
                                fontSize: 12,
                                color: "var(--success)",
                              }}
                            >
                              <Icon name="cal" size={13} />
                              {formatRenewExpiry(row.email, row.months)}
                            </div>
                          ) : free ? (
                            <div
                              title={t("invite.feeFreeReinvite")}
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 6,
                                fontFamily: "var(--font-mono)",
                                fontSize: 12,
                                color: "var(--success)",
                              }}
                            >
                              <Icon name="cal" size={13} />
                              {formatFreeExpiry(row.email)}
                            </div>
                          ) : (
                            <div
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 6,
                                fontFamily: "var(--font-mono)",
                                fontSize: 12,
                                color: "var(--ink-3)",
                              }}
                            >
                              <Icon name="cal" size={13} />
                              {formatExpiresDate(row.months)}
                            </div>
                          )}

                          {/* xoá */}
                          <button
                            onClick={() => removeEntry(row.email)}
                            disabled={bulkInvite.isPending}
                            title={t("invite.removeRow")}
                            style={{
                              border: "none",
                              background: "transparent",
                              color: "var(--ink-3)",
                              cursor: "pointer",
                              width: 26,
                              height: 26,
                              borderRadius: 6,
                              fontSize: 16,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                          >
                            ×
                          </button>
                        </div>
                      );
                    })
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* footer */}
            <div
              style={{
                borderTop: "1px solid var(--border)",
                padding: "13px 20px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                flexWrap: "wrap",
                background: "var(--surface-2)",
              }}
            >
              {/* Dòng tổng kết + cảnh báo mua thêm suất: to hơn phần chữ phụ khác
                  (14.5 thay vì 12.5) vì đây là chỗ chốt tiền, phải đọc được ngay. */}
              <div style={{ fontSize: 14.5, color: "var(--ink-3)" }}>
                {t("invite.parsed", { n: entries.length })}
                {" · "}
                {t("invite.feeChargedCount", { n: chargedCount })}
                {freeCount > 0 && (
                  <>
                    {" · "}
                    <span style={{ color: "var(--success)" }}>
                      {t("invite.feeFreeCount", { n: freeCount })}
                    </span>
                  </>
                )}
                {" · "}
                {t("invite.feeTotalInline", {
                  total: feePreview.isFetching
                    ? "…"
                    : formatVnd(feePreview.data?.total ?? 0),
                })}
                {/* Thiếu suất: extension phải mua thêm trên ChatGPT bằng tiền thật rồi
                    mới mời được, nên lệnh chạy lâu hơn — nói trước để người dùng khỏi
                    tưởng treo mà bấm lại. */}
                {seatToBuy > 0 && (
                  <>
                    {" · "}
                    <span style={{ color: "var(--danger)", fontWeight: 600 }}>
                      {t("inviteMembers.seatBuyNote", { n: seatToBuy })}
                    </span>
                  </>
                )}
              </div>
              <div style={{ display: "flex", gap: 9 }}>
                <button
                  onClick={() => {
                    setEmailsText("");
                    setMonthsByEmail({});
                    setWorkspaceByEmail({});
                  }}
                  disabled={bulkInvite.isPending || entries.length === 0}
                  className="btn btn-ghost"
                >
                  {t("common.cancel")}
                </button>
                <button
                  onClick={() => bulkInvite.mutate()}
                  disabled={!canSubmit}
                  className="btn btn-primary"
                >
                  {bulkInvite.isPending
                    ? t("invite.submitBusyShort")
                    : renewCount > 0
                      ? t("invite.submitMixed", { n: entries.length })
                      : t("invite.submit", { n: entries.length })}
                </button>
              </div>
            </div>
          </div>

          {/* CỘT PHẢI — task đang chạy + lịch sử */}
          <div
            style={{
              flex: isMobile ? "1 1 100%" : "1 1 300px",
              width: isMobile ? "100%" : "auto",
              maxWidth: isMobile ? "100%" : 360,
              display: "flex",
              flexDirection: "column",
              gap: 16,
            }}
          >
            <TaskPanels workspaceId={workspaceId} />
          </div>
        </div>
      )}
      </div>
    </div>
  );
}

function tagStyle(kind: "accent" | "success"): React.CSSProperties {
  return {
    flexShrink: 0,
    fontSize: 9.5,
    fontWeight: 700,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    padding: "2px 7px",
    borderRadius: 5,
    whiteSpace: "nowrap",
    color: kind === "accent" ? "var(--success)" : "var(--success)",
    background: "var(--success-bg)",
    border: "1px solid transparent",
  };
}

const stepBtn: React.CSSProperties = {
  flex: "none",
  border: "none",
  background: "transparent",
  width: 26,
  height: 28,
  fontSize: 15,
  color: "var(--ink-3)",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

/**
 * Thẻ 1 email trên MOBILE (theo mockup "Mời thành viên"): email + tag trạng thái,
 * nút xoá; lưới 2 cột Không-gian / Số-tháng; dòng "Hết hạn". Logic (chọn workspace,
 * stepper, hết hạn, xoá) do trang cha truyền xuống — thẻ chỉ lo bố cục.
 */
function MobileInviteCard({
  row,
  renew,
  free,
  wsOptions,
  selectedWs,
  busy,
  usedText,
  seatLabel,
  seatAlarm,
  onWs,
  onDec,
  onInc,
  onRemove,
  expiry,
  expiryFree,
  t,
}: {
  row: { email: string; emailRaw: string; months: number };
  renew: boolean;
  free: boolean;
  // Không gian chọn được (lịch sử cho email cũ / đích được cấp cho email mới).
  wsOptions: { id: string; name: string; usageDays?: number }[];
  selectedWs: string | undefined;
  busy: boolean;
  usedText: (days: number) => string;
  /** Nhãn suất còn trống của 1 không gian ("còn 4" / "hết suất"), "" khi chưa biết tổng. */
  seatLabel: (wsId: string | undefined) => string;
  /** Hết suất hoặc không đủ cho danh sách đang dán → nhãn suất chuyển đỏ. */
  seatAlarm: boolean;
  onWs: (v: string) => void;
  onDec: () => void;
  onInc: () => void;
  onRemove: () => void;
  expiry: string;
  expiryFree: boolean;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const cellLabel: React.CSSProperties = {
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "var(--ink-3)",
    marginBottom: 6,
  };
  const selectedOpt = wsOptions.find((o) => o.id === selectedWs);
  // Tooltip ô Không gian: email cũ kèm "đã dùng X tháng", email mới chỉ tên.
  const selectedTitle =
    selectedOpt === undefined
      ? undefined
      : selectedOpt.usageDays === undefined
        ? selectedOpt.name
        : t("inviteMembers.wsOption", {
            name: selectedOpt.name,
            used: usedText(selectedOpt.usageDays),
          });
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 14,
        padding: 14,
        background: "var(--surface)",
        boxShadow: "var(--shadow-card)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      {/* email + tag + xoá */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            title={row.emailRaw}
            style={{
              fontSize: 14.5,
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {row.emailRaw}
          </div>
          {renew ? (
            <span style={{ ...tagStyle("accent"), marginTop: 5, display: "inline-flex" }}>
              ↻ {t("invite.tagRenew")}
            </span>
          ) : free ? (
            <span style={{ ...tagStyle("success"), marginTop: 5, display: "inline-flex" }}>
              ✓ {t("invite.tagReinvite")}
            </span>
          ) : null}
        </div>
        <button
          onClick={onRemove}
          disabled={busy}
          title={t("invite.removeRow")}
          style={{
            flex: "none",
            border: "none",
            background: "var(--surface-2)",
            color: "var(--ink-3)",
            cursor: "pointer",
            width: 32,
            height: 32,
            borderRadius: 8,
            fontSize: 18,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          ×
        </button>
      </div>

      {/* lưới không-gian / số-tháng */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={cellLabel}>{t("inviteMembers.colWorkspace")}</div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: "9px 11px",
              background: "var(--surface)",
              minWidth: 0,
            }}
            title={selectedTitle}
          >
            <span style={wsDot} />
            {wsOptions.length > 1 ? (
              <>
                <select
                  value={selectedWs ?? ""}
                  onChange={(e) => onWs(e.target.value)}
                  disabled={busy}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    border: "none",
                    background: "transparent",
                    fontFamily: "var(--font-sans)",
                    fontSize: 13.5,
                    color: "var(--ink)",
                    outline: "none",
                    cursor: "pointer",
                    WebkitAppearance: "none",
                    appearance: "none",
                  }}
                >
                  {wsOptions.map((o) => (
                    <option
                      key={o.id}
                      value={o.id}
                      title={o.usageDays === undefined ? undefined : usedText(o.usageDays)}
                    >
                      {seatLabel(o.id) ? `${o.name} · ${seatLabel(o.id)}` : o.name}
                    </option>
                  ))}
                </select>
                <span style={{ color: "var(--ink-3)", fontSize: 10 }}>▾</span>
              </>
            ) : (
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 13.5,
                  color: "var(--ink-2)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {selectedOpt?.name ?? wsOptions[0]?.name ?? "—"}
              </span>
            )}
            {/* Suất còn trống của không gian đang chọn — đỏ khi không đủ cho
                danh sách đang dán (mời tiếp = mua thêm suất bằng tiền thật). */}
            {seatLabel(selectedWs) ? (
              <span
                style={{
                  flex: "none",
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  fontWeight: 600,
                  padding: "2px 7px",
                  borderRadius: 6,
                  background: seatAlarm ? "var(--danger-bg)" : "var(--surface-2)",
                  color: seatAlarm ? "var(--danger)" : "var(--ink-2)",
                }}
              >
                {seatLabel(selectedWs)}
              </span>
            ) : null}
          </div>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={cellLabel}>{t("invite.colMonths")}</div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              border: "1px solid var(--border)",
              borderRadius: 10,
              overflow: "hidden",
            }}
          >
            <button
              onClick={onDec}
              disabled={busy || row.months <= MIN_MONTHS}
              style={mobileStepBtn}
            >
              −
            </button>
            <div
              style={{
                flex: 1,
                textAlign: "center",
                fontSize: 14,
                fontWeight: 600,
                fontFamily: "var(--font-mono)",
                borderLeft: "1px solid var(--border)",
                borderRight: "1px solid var(--border)",
                lineHeight: "36px",
              }}
            >
              {row.months}
            </div>
            <button
              onClick={onInc}
              disabled={busy || row.months >= MAX_MONTHS}
              style={mobileStepBtn}
            >
              +
            </button>
          </div>
        </div>
      </div>

      {/* hết hạn */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          fontFamily: "var(--font-mono)",
          fontSize: 12.5,
          color: expiryFree ? "var(--success)" : "var(--ink-3)",
        }}
      >
        {!expiryFree && <Icon name="cal" size={13} />}
        {expiryFree ? (
          <span style={{ fontWeight: 600 }}>{expiry}</span>
        ) : (
          <>
            {t("invite.colExpires")}:{" "}
            <span style={{ color: renew ? "var(--success)" : "var(--ink)", fontWeight: 500 }}>
              {expiry}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

const mobileStepBtn: React.CSSProperties = {
  flex: "none",
  border: "none",
  background: "transparent",
  width: 38,
  height: 38,
  fontSize: 18,
  color: "var(--ink-3)",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

function ExtensionPill({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const { online } = useExtensionStatus(workspaceId);
  const on = online === true;
  return (
    <span
      className="flex items-center"
      style={{
        gap: 7,
        fontSize: 12.5,
        padding: "6px 12px",
        borderRadius: 999,
        border: "1px solid var(--border)",
        background: "var(--surface)",
        color: on ? "var(--success)" : "var(--ink-3)",
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: on ? "var(--success)" : "var(--ink-3)",
        }}
      />
      {on ? t("inviteMembers.extOnline") : t("inviteMembers.extOffline")}
    </span>
  );
}

/** Cột phải: task đang chạy (thanh tiến trình) + lịch sử luồng chạy. */
function TaskPanels({ workspaceId }: { workspaceId: string | undefined }) {
  const t = useT();
  const tTaskType = useTranslateEnum("taskType");
  const formatDate = useFormatDate();

  const { data: tasks = [] } = useQuery({
    queryKey: ["invite-queue", workspaceId],
    queryFn: () =>
      api<QueueItem[]>(`/api/v1/queue?workspace_id=${workspaceId}&limit=40`),
    enabled: !!workspaceId,
    refetchInterval: queuePollInterval(2000, 10000),
  });

  const running = tasks.filter(
    (tk) => tk.status === "PENDING" || tk.status === "IN_PROGRESS",
  );
  const history = tasks
    .filter((tk) => tk.status === "COMPLETED" || tk.status === "FAILED")
    .slice(0, 8);

  const taskLabel = (tk: QueueItem): string => {
    const emails = Array.isArray(tk.payload?.emails)
      ? (tk.payload.emails as string[])
      : tk.payload?.email
        ? [tk.payload.email as string]
        : [];
    if (tk.type === "INVITE_MEMBER" && emails.length > 0) {
      return t("inviteMembers.taskInvite", { n: emails.length });
    }
    return tTaskType(tk.type);
  };

  const whenText = (iso: string | null): string => {
    if (!iso) return "";
    const d = new Date(iso);
    const now = new Date();
    const hhmm = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    const yest = new Date(now);
    yest.setDate(now.getDate() - 1);
    const day =
      d.toDateString() === now.toDateString()
        ? t("inviteMembers.today")
        : d.toDateString() === yest.toDateString()
          ? t("inviteMembers.yesterday")
          : formatDate(d, { day: "numeric", month: "numeric", year: "numeric" });
    return `${hhmm} · ${day}`;
  };

  return (
    <>
      {/* Task đang chạy */}
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          overflow: "hidden",
          background: running.length > 0 ? "var(--success-bg)" : "var(--surface)",
          boxShadow: "var(--shadow-card)",
        }}
      >
        <div
          className="flex items-center justify-between"
          style={{ padding: "13px 15px", borderBottom: "1px solid var(--border)" }}
        >
          <div className="flex items-center" style={{ gap: 8 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: running.length > 0 ? "var(--success)" : "var(--ink-3)",
              }}
            />
            <span style={{ fontWeight: 600, fontSize: 13.5 }}>
              {t("inviteMembers.runningTitle")}
            </span>
          </div>
          <span
            style={{
              ...monoLabel,
              textTransform: "none",
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              padding: "3px 8px",
              borderRadius: 20,
            }}
          >
            {t("inviteMembers.runningMeta", { n: running.length })}
          </span>
        </div>
        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 14 }}>
          {running.length === 0 ? (
            <div
              className="cell-muted"
              style={{ fontSize: 13, textAlign: "center", padding: "8px 0" }}
            >
              {t("inviteMembers.runningEmpty")}
            </div>
          ) : (
            running.map((tk) => (
              <RunningRow key={tk.id} task={tk} label={taskLabel(tk)} />
            ))
          )}
        </div>
      </div>

      {/* Lịch sử luồng chạy */}
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          overflow: "hidden",
          background: "var(--surface)",
          boxShadow: "var(--shadow-card)",
        }}
      >
        <div
          className="flex items-center justify-between"
          style={{ padding: "13px 15px", borderBottom: "1px solid var(--border)" }}
        >
          <span style={{ fontWeight: 600, fontSize: 13.5 }}>
            {t("inviteMembers.historyTitle")}
          </span>
          <span style={{ ...monoLabel, textTransform: "none" }}>
            {t("inviteMembers.historyMeta")}
          </span>
        </div>
        <div style={{ padding: "6px 0" }}>
          {history.length === 0 ? (
            <div
              className="cell-muted"
              style={{ fontSize: 13, textAlign: "center", padding: "14px 0" }}
            >
              {t("inviteMembers.historyEmpty")}
            </div>
          ) : (
            history.map((tk) => (
              <div
                key={tk.id}
                className="flex items-start"
                style={{ gap: 10, padding: "10px 15px" }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    marginTop: 5,
                    flexShrink: 0,
                    background:
                      tk.status === "FAILED" ? "var(--danger)" : "var(--success)",
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "var(--ink)" }}>
                    {taskLabel(tk)}
                  </div>
                  {/* Lệnh hỏng: người dùng cần MỘT CÂU biết phải làm gì, không
                      cần mã kỹ thuật. Backend đã rút gọn `error_message` cho tài
                      khoản không phải super-admin (`services/task_errors.py`) —
                      ở đây chỉ việc hiện nó, giữ 2 dòng cho gọn hàng. */}
                  <div
                    style={{
                      fontSize: 11.5,
                      color: tk.status === "FAILED" ? "var(--danger)" : "var(--ink-3)",
                      marginTop: 2,
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                    title={tk.status === "FAILED" ? tk.error_message ?? "" : undefined}
                  >
                    {tk.status === "FAILED"
                      ? tk.error_message ?? tk.error_code ?? t("sync.failedUnknown")
                      : tTaskType(tk.type)}
                  </div>
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--ink-3)",
                    fontFamily: "var(--font-mono)",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                    textAlign: "right",
                  }}
                >
                  {whenText(tk.completed_at ?? tk.created_at)}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}

function RunningRow({ task, label }: { task: QueueItem; label: string }) {
  const t = useT();
  const progress = task.progress;
  const current = typeof progress?.current === "number" ? progress.current : null;
  const total = typeof progress?.total === "number" ? progress.total : null;
  const pct =
    current != null && total != null && total > 0
      ? Math.min(100, Math.round((current / total) * 100))
      : task.status === "IN_PROGRESS"
        ? 50
        : 8;
  const isSending = task.status === "IN_PROGRESS";

  return (
    <div>
      <div className="flex items-center justify-between" style={{ gap: 8, marginBottom: 8 }}>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12.5,
            color: "var(--ink)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
        <span
          style={{
            flexShrink: 0,
            fontSize: 9.5,
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            padding: "2px 7px",
            borderRadius: 6,
            color: isSending ? "var(--success)" : "var(--warning, var(--ink-2))",
            background: "var(--surface)",
            border: "1px solid var(--border)",
          }}
        >
          {isSending ? t("inviteMembers.sending") : t("inviteMembers.queued")}
        </span>
      </div>
      <div
        style={{
          height: 6,
          borderRadius: 999,
          background: "var(--surface)",
          overflow: "hidden",
          border: "1px solid var(--border)",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: isSending ? "var(--success)" : "var(--warning, var(--ink-3))",
            transition: "width .4s ease",
          }}
        />
      </div>
      <div
        className="flex items-center justify-between"
        style={{ marginTop: 6, fontSize: 11, color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}
      >
        <span>
          {current != null && total != null
            ? t("inviteMembers.processed", { current, total })
            : t("inviteMembers.waitingSlot")}
        </span>
        <span>{pct}%</span>
      </div>
    </div>
  );
}
