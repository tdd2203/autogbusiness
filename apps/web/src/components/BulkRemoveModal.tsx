/**
 * Modal CẬP NHẬT hàng loạt — paste-driven, song song với cách chọn checkbox trong bảng.
 *
 * UX:
 *   1. Admin chọn HÀNH ĐỘNG: Xoá khỏi workspace | Đổi giấy phép → ChatGPT/Codex |
 *      Chuyển chủ sở hữu (super-admin) | Đặt giới hạn tín dụng/tháng.
 *   2. Paste danh sách email vào textarea (1/dòng hoặc cách nhau comma/;).
 *   3. Panel bên phải hiện BẢNG THÔNG TIN từng email (ngày thêm, hạn dùng, chủ sở
 *      hữu) — tra cứu qua POST /members/lookup. Email không khớp member nào hiện mờ.
 *   4. Riêng "Chuyển chủ sở hữu": hiện thêm ô chọn người nhận phía trên bảng.
 *   5. Riêng "Đặt giới hạn tín dụng": có ô nhập MỨC CHUNG cho tất cả; nếu muốn mỗi
 *      người một mức RIÊNG thì gõ cú pháp `email=số` trên từng dòng (riêng > chung).
 *      Bảng hiện cột "Giới hạn hiện tại" → "mới".
 *   6. Submit → bulk-remove | bulk-change-license-type | transfer-owner |
 *      bulk-set-usage-limit.
 *
 * Lookup + transfer giới hạn trong WORKSPACE hiện tại (transfer chỉ gửi member_id
 * khớp email trong workspace này → tái dùng endpoint /added-members/transfer-owner).
 *
 * Quyền: "Xoá" + "Đặt giới hạn" cần MEMBER_REMOVE; "Đổi giấy phép" + "Chuyển chủ"
 * cần super-admin. Chỉ hiện những hành động user có quyền.
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatDate, useT } from "../i18n";
import { useAuth } from "../hooks/useAuth";
import { useIsMobile } from "../hooks/useIsMobile";
import { api, ApiError } from "../lib/api";
import { LICENSE_FEATURE_ENABLED } from "../lib/featureFlags";
import { toast } from "./Toast";

type BulkAction =
  | "remove"
  | "renew"
  | "license:ChatGPT"
  | "license:Codex"
  | "transfer-owner"
  | "set-usage-limit";

type LookupRow = {
  member_id: string;
  email: string;
  name: string | null;
  status: string;
  license_type: string | null;
  added_at: string;
  subscription_end_at: string | null;
  usage_limit_credits: number | null;
  owner_user_id: string | null;
  owner_username: string | null;
};
type LookupOut = { found: LookupRow[]; not_found: string[] };
/** 1 dòng đã tính cho chế độ GIA HẠN (xem renewComputed). */
type RenewComputedRow = {
  lower: string;
  emailRaw: string;
  memberId: string | null;
  matched: boolean;
  /** Hạn hiện tại (subscription_end_at), null = chưa có / vô thời hạn. */
  currentEnd: Date | null;
  /** Ngày gia hạn hiệu lực (mặc định cộng dồn = max(hôm nay, hạn hiện tại)). */
  start: Date;
  /** Hạn mới hiệu lực = ngày gia hạn + tháng×30, chốt 23:59:59 (hoặc sửa tay). */
  newEnd: Date;
  /** Tuỳ chỉnh số tháng/ngày RIÊNG dòng này (bấm "+"); null = dùng số tháng chung. */
  durOverride: { months: string; days: string } | null;
  /** Đang tích để gửi đi (chỉ dòng khớp member). */
  selected: boolean;
};
type SubAccount = { id: string; username: string };
type BulkResp =
  | {
      count: number;
      emails: string[];
      skipped: string[];
      already?: string[];
      no_target?: string[];
      /** Đặt giới hạn bởi sub-admin: lệnh đã gửi & đang CHỜ admin duyệt. */
      pending_approval?: boolean;
    }
  | { count: number; target_username: string };

const EMAIL_RE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i;
const MAX_LIMIT_CREDITS = 1_000_000;
/** 1 tháng gia hạn = 30 ngày (đồng bộ với BulkUpdateExpiryModal + backend). */
const SUBSCRIPTION_DAYS = 30;

/** Chuỗi `yyyy-mm-dd` (giờ địa phương) cho <input type="date">. */
function toDateInputValue(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Parse `yyyy-mm-dd` → Date giờ địa phương lúc 00:00 (null nếu sai định dạng). */
function parseDateInput(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
}

/** Cộng `days` ngày vào 1 mốc, GIỮ NGUYÊN giờ:phút:giây (Model B — hạn = mốc + N ngày chính xác). */
function addDaysKeepTime(base: Date, days: number): Date {
  return new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate() + days,
    base.getHours(),
    base.getMinutes(),
    base.getSeconds(),
    0,
  );
}

type ParsedEmails = {
  validUnique: string[];
  validRaw: string[];
  invalid: string[];
  duplicates: string[];
  /** email(lower) → mức tín dụng RIÊNG (chỉ chế độ đặt giới hạn, cú pháp `email=số`). */
  creditsByEmail: Map<string, number>;
};

function parseEmails(raw: string): ParsedEmails {
  const tokens = raw
    .split(/[\n,;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const seen = new Set<string>();
  const validUnique: string[] = [];
  const validRaw: string[] = [];
  const invalid: string[] = [];
  const duplicates: string[] = [];
  for (const tok of tokens) {
    if (!EMAIL_RE.test(tok)) {
      invalid.push(tok);
      continue;
    }
    const lower = tok.toLowerCase();
    if (seen.has(lower)) {
      duplicates.push(tok);
      continue;
    }
    seen.add(lower);
    validUnique.push(lower);
    validRaw.push(tok);
  }
  return { validUnique, validRaw, invalid, duplicates, creditsByEmail: new Map() };
}

/**
 * Parser riêng cho chế độ "Đặt giới hạn tín dụng": mỗi token có thể là `email`
 * (dùng mức CHUNG) hoặc `email=số` (mức RIÊNG cho email đó). Token tách bởi
 * newline/`;` — KHÔNG tách bởi `,` ở đây vì người dùng có thể gõ 1 email/dòng và
 * dấu `,` dễ nhầm; nhưng vẫn nhận `,` như separator giống parseEmails để đồng nhất.
 */
function parseUsageLimit(raw: string): ParsedEmails {
  const tokens = raw
    .split(/[\n,;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const seen = new Set<string>();
  const validUnique: string[] = [];
  const validRaw: string[] = [];
  const invalid: string[] = [];
  const duplicates: string[] = [];
  const creditsByEmail = new Map<string, number>();
  for (const tok of tokens) {
    const eq = tok.indexOf("=");
    const emailPart = (eq >= 0 ? tok.slice(0, eq) : tok).trim();
    const creditsPart = eq >= 0 ? tok.slice(eq + 1).trim() : "";
    if (!EMAIL_RE.test(emailPart)) {
      invalid.push(tok);
      continue;
    }
    // Có `=` nhưng phần số sai (không phải số nguyên ≥0 hợp lệ) → coi token lỗi.
    let credits: number | null = null;
    if (eq >= 0) {
      if (!/^\d+$/.test(creditsPart) || Number(creditsPart) > MAX_LIMIT_CREDITS) {
        invalid.push(tok);
        continue;
      }
      credits = Number(creditsPart);
    }
    const lower = emailPart.toLowerCase();
    if (seen.has(lower)) {
      duplicates.push(tok);
      continue;
    }
    seen.add(lower);
    validUnique.push(lower);
    validRaw.push(emailPart);
    if (credits !== null) creditsByEmail.set(lower, credits);
  }
  return { validUnique, validRaw, invalid, duplicates, creditsByEmail };
}

export function BulkRemoveModal({
  workspaceId,
  onClose,
  onDone,
  initialAction,
  initialEmails,
}: {
  workspaceId: string;
  onClose: () => void;
  onDone: () => void;
  /** Mở sẵn ở hành động này (vd "set-usage-limit" từ dropdown inline). */
  initialAction?: string;
  /** Điền sẵn danh sách email (mỗi email 1 dòng). */
  initialEmails?: string[];
}) {
  const t = useT();
  const formatDate = useFormatDate();
  const isMobile = useIsMobile();
  const { hasPermission, user } = useAuth();
  const qc = useQueryClient();
  const canRemove = hasPermission("MEMBER_REMOVE");
  const isSuper = user?.is_super_admin === true;
  // Gia hạn hàng loạt: cùng quyền với đổi hạn 1 member (MEMBER_INVITE). super-admin
  // áp NGAY; sub-admin tạo yêu cầu chờ duyệt (tái dùng /added-members/bulk-set-expiry).
  const canRenew = isSuper || hasPermission("MEMBER_INVITE");
  // Đổi giấy phép đã ẩn qua cờ LICENSE_FEATURE_ENABLED (lib/featureFlags.ts) —
  // ChatGPT mặc định "ChatGPT" nên không còn khớp. Cờ = false ⇒ ẩn 2 option đổi
  // giấy phép trong dropdown hành động.
  const canChangeLicense = LICENSE_FEATURE_ENABLED && isSuper;
  const canTransfer = isSuper;
  // Đặt giới hạn tín dụng: quyền MEMBER_SET_USAGE_LIMIT (khớp gate backend). Với
  // sub-admin, mọi lệnh sẽ vào trạng thái CHỜ ADMIN DUYỆT + ràng buộc ngân sách.
  const canSetUsageLimit = hasPermission("MEMBER_SET_USAGE_LIMIT");

  const [emailsText, setEmailsText] = useState(
    initialEmails && initialEmails.length > 0 ? initialEmails.join("\n") : "",
  );
  const [confirmed, setConfirmed] = useState(false);
  const [targetUserId, setTargetUserId] = useState("");
  // Mức tín dụng/tháng CHUNG (chế độ đặt giới hạn). Để trống nếu mỗi người gõ
  // mức riêng bằng cú pháp `email=số`.
  const [limitCreditsText, setLimitCreditsText] = useState("");
  // ── Gia hạn hàng loạt ──────────────────────────────────────────────────
  // Số tháng CHUNG (mỗi tháng = 30 ngày), mặc định 1. Sửa tay từng dòng qua override.
  const [monthsText, setMonthsText] = useState("1");
  // Email BỎ tích (mặc định TÍCH SẴN mọi email khớp → chỉ lưu cái bị bỏ tích).
  const [renewDeselected, setRenewDeselected] = useState<Set<string>>(
    () => new Set(),
  );
  // Override "ngày gia hạn" / "hạn mới" từng dòng (yyyy-mm-dd, giờ địa phương).
  const [renewStartOverrides, setRenewStartOverrides] = useState<
    Record<string, string>
  >({});
  const [renewEndOverrides, setRenewEndOverrides] = useState<
    Record<string, string>
  >({});
  // Tuỳ chỉnh số tháng/ngày RIÊNG từng dòng (bấm "+") — ghi đè "số tháng chung" cho
  // riêng email đó. Khi có: hạn mới = ngày gia hạn + (tháng×30 + ngày). Ghim hạn mới
  // tay (renewEndOverrides) xung khắc với cái này → set cái nào thì xoá cái kia.
  const [renewDurOverrides, setRenewDurOverrides] = useState<
    Record<string, { months: string; days: string }>
  >({});
  // Hành động mặc định: initialAction (nếu được mở từ dropdown) → ưu tiên "xoá" →
  // đổi giấy phép.
  // Mặc định: ưu tiên "xoá"; nếu không có quyền xoá thì rơi về "đặt giới hạn"
  // (option luôn hiển thị). KHÔNG mặc định sang license:* vì đã ẩn qua cờ.
  const [action, setAction] = useState<BulkAction>(
    (initialAction as BulkAction | undefined) ??
      (canRemove ? "remove" : "set-usage-limit"),
  );
  const isRemove = action === "remove";
  const isTransfer = action === "transfer-owner";
  const isUsageLimit = action === "set-usage-limit";
  const isRenew = action === "renew";

  // Số tháng gia hạn chung (≥1) → thời hạn = tháng × 30 ngày.
  const monthsTrimmed = monthsText.trim();
  const monthsValid = /^\d+$/.test(monthsTrimmed) && Number(monthsTrimmed) >= 1;
  const renewMonths = monthsValid ? Number(monthsTrimmed) : 1;
  const renewDurationDays = renewMonths * SUBSCRIPTION_DAYS;
  // Mốc "bây giờ" ổn định suốt phiên mở modal (gia hạn cộng dồn thông minh).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const renewNow = useMemo(() => new Date(), []);

  const { validUnique, validRaw, invalid, duplicates, creditsByEmail } = useMemo(
    () => (isUsageLimit ? parseUsageLimit(emailsText) : parseEmails(emailsText)),
    [emailsText, isUsageLimit],
  );

  // Mức chung đã nhập hợp lệ? ("" = chưa nhập, vẫn hợp lệ nếu mọi email có mức riêng)
  const commonLimitTrimmed = limitCreditsText.trim();
  const commonLimitSet = commonLimitTrimmed.length > 0;
  const commonLimitValid =
    !commonLimitSet ||
    (/^\d+$/.test(commonLimitTrimmed) &&
      Number(commonLimitTrimmed) <= MAX_LIMIT_CREDITS);
  // Có email nào DỰA vào mức chung (không gõ `email=số`)?
  const needsCommonLimit = useMemo(
    () => validUnique.some((lower) => !creditsByEmail.has(lower)),
    [validUnique, creditsByEmail],
  );
  // Sẵn sàng đặt giới hạn: có email + mức chung hợp lệ + nếu cần mức chung thì đã nhập.
  const usageReady =
    validUnique.length > 0 &&
    commonLimitValid &&
    (!needsCommonLimit || commonLimitSet);

  // Ngân sách tín dụng của caller trong workspace (chỉ cần ở chế độ đặt giới hạn).
  // super-admin: unlimited. sub-admin: budget/used/remaining + mọi lệnh chờ duyệt.
  const budgetQuery = useQuery({
    queryKey: ["usage-limit-budget", workspaceId],
    enabled: isUsageLimit && canSetUsageLimit,
    staleTime: 10_000,
    queryFn: () =>
      api<{
        unlimited: boolean;
        budget: number;
        used: number;
        remaining: number;
      }>(`/api/v1/workspaces/${workspaceId}/members/usage-limit-budget`),
  });
  const budget = budgetQuery.data;

  // Debounce key tra cứu: tránh gọi /lookup mỗi lần gõ. validUnique đã sort-stable
  // theo thứ tự dán; join để so sánh ổn định giữa các lần render.
  const lookupSig = validUnique.join(",");
  const [debouncedSig, setDebouncedSig] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSig(lookupSig), 350);
    return () => clearTimeout(id);
  }, [lookupSig]);

  const lookupQuery = useQuery({
    queryKey: ["member-lookup", workspaceId, debouncedSig],
    enabled: debouncedSig.length > 0,
    staleTime: 30_000,
    queryFn: () =>
      api<LookupOut>(`/api/v1/workspaces/${workspaceId}/members/lookup`, {
        method: "POST",
        body: JSON.stringify({ emails: debouncedSig.split(",") }),
      }),
  });
  const lookup = lookupQuery.data;
  // Map email(lower) → thông tin member, để overlay lên danh sách email đã dán.
  const foundByEmail = useMemo(() => {
    const m = new Map<string, LookupRow>();
    for (const row of lookup?.found ?? []) m.set(row.email.toLowerCase(), row);
    return m;
  }, [lookup]);
  const foundMemberIds = useMemo(
    () => (lookup?.found ?? []).map((r) => r.member_id),
    [lookup],
  );
  // Chỉ tin kết quả lookup khi đã khớp đúng tập email hiện tại (tránh dùng kết
  // quả cũ khi user vừa sửa danh sách mà debounce chưa chạy lại).
  const lookupReady = lookupQuery.isSuccess && debouncedSig === lookupSig;

  // ── Bảng GIA HẠN ─────────────────────────────────────────────────────────
  // Với mỗi email: ngày gia hạn mặc định = max(hôm nay, hạn hiện tại) (cộng dồn
  // thông minh); hạn mới = ngày gia hạn + tháng×30, chốt 23:59:59. Override tay được.
  // Chỉ dòng KHỚP member + đang TÍCH mới đưa vào danh sách gửi.
  const renewComputed = useMemo<RenewComputedRow[]>(() => {
    if (!isRenew) return [];
    return validUnique.map((lower, idx) => {
      const row = foundByEmail.get(lower);
      const currentEnd = row?.subscription_end_at
        ? new Date(row.subscription_end_at)
        : null;
      const parsedStart = renewStartOverrides[lower]
        ? parseDateInput(renewStartOverrides[lower])
        : null;
      let start: Date;
      if (parsedStart) start = parsedStart;
      else if (currentEnd && currentEnd.getTime() > renewNow.getTime())
        start = currentEnd;
      else start = renewNow;
      const parsedEnd = renewEndOverrides[lower]
        ? parseDateInput(renewEndOverrides[lower])
        : null;
      // Ưu tiên hạn mới: ghim tay > tuỳ chỉnh tháng/ngày riêng > số tháng chung.
      const durOverride = renewDurOverrides[lower] ?? null;
      // Model B: giữ giờ chính xác, KHÔNG chốt 23:59:59. Nhập thẳng hạn → dùng đúng
      // ngày/giờ nhập; gia hạn → start + N ngày chính xác (giữ giờ của start).
      let newEnd: Date;
      if (parsedEnd) {
        newEnd = parsedEnd;
      } else if (durOverride) {
        const m = /^\d+$/.test(durOverride.months.trim())
          ? Number(durOverride.months.trim())
          : 0;
        const d = /^\d+$/.test(durOverride.days.trim())
          ? Number(durOverride.days.trim())
          : 0;
        newEnd = addDaysKeepTime(start, m * SUBSCRIPTION_DAYS + d);
      } else {
        newEnd = addDaysKeepTime(start, renewDurationDays);
      }
      return {
        lower,
        emailRaw: validRaw[idx],
        memberId: row?.member_id ?? null,
        matched: !!row,
        currentEnd,
        start,
        newEnd,
        durOverride,
        selected: !!row && !renewDeselected.has(lower),
      };
    });
  }, [
    isRenew,
    validUnique,
    validRaw,
    foundByEmail,
    renewStartOverrides,
    renewEndOverrides,
    renewDurOverrides,
    renewDeselected,
    renewNow,
    renewDurationDays,
  ]);

  const renewItems = useMemo(
    () =>
      renewComputed
        .filter((r) => r.selected && r.memberId)
        .map((r) => ({
          member_id: r.memberId as string,
          end_at: r.newEnd.toISOString(),
        })),
    [renewComputed],
  );
  const renewSelectedCount = renewItems.length;
  const renewMatchedLowers = useMemo(
    () => renewComputed.filter((r) => r.matched).map((r) => r.lower),
    [renewComputed],
  );
  const renewAllSelected =
    renewMatchedLowers.length > 0 &&
    renewMatchedLowers.every((l) => !renewDeselected.has(l));

  function toggleRenewRow(lower: string) {
    setRenewDeselected((prev) => {
      const next = new Set(prev);
      if (next.has(lower)) next.delete(lower);
      else next.add(lower);
      return next;
    });
    setConfirmed(false);
  }
  function toggleRenewAll() {
    // Đang chọn hết → bỏ tích tất cả; ngược lại → tích lại tất cả.
    setRenewDeselected(
      renewAllSelected ? new Set(renewMatchedLowers) : new Set(),
    );
    setConfirmed(false);
  }
  function setRenewStart(lower: string, val: string) {
    setRenewStartOverrides((prev) => ({ ...prev, [lower]: val }));
    // Sửa ngày gia hạn → hạn mới tính lại = start + tháng×30 (bỏ ghim hạn mới tay).
    setRenewEndOverrides((prev) => {
      if (!(lower in prev)) return prev;
      const next = { ...prev };
      delete next[lower];
      return next;
    });
    setConfirmed(false);
  }
  function setRenewEnd(lower: string, val: string) {
    setRenewEndOverrides((prev) => ({ ...prev, [lower]: val }));
    // Ghim hạn mới tay → bỏ tuỳ chỉnh tháng/ngày riêng (xung khắc).
    setRenewDurOverrides((prev) => {
      if (!(lower in prev)) return prev;
      const next = { ...prev };
      delete next[lower];
      return next;
    });
    setConfirmed(false);
  }
  // Bật/tắt tuỳ chỉnh số tháng/ngày RIÊNG cho 1 dòng (nút "+"). Bật → khởi tạo từ số
  // tháng chung + 0 ngày; tắt → quay về số tháng chung. Bật cũng bỏ ghim hạn mới tay.
  function toggleRenewDur(lower: string) {
    setRenewDurOverrides((prev) => {
      const next = { ...prev };
      if (lower in next) delete next[lower];
      else next[lower] = { months: monthsValid ? monthsTrimmed : "1", days: "0" };
      return next;
    });
    setRenewEndOverrides((prev) => {
      if (!(lower in prev)) return prev;
      const next = { ...prev };
      delete next[lower];
      return next;
    });
    setConfirmed(false);
  }
  function setRenewDur(lower: string, field: "months" | "days", val: string) {
    setRenewDurOverrides((prev) => {
      const cur = prev[lower] ?? { months: "", days: "" };
      return { ...prev, [lower]: { ...cur, [field]: val } };
    });
    setConfirmed(false);
  }

  // Danh sách tài khoản nhận quyền sở hữu (chỉ cần khi chuyển chủ).
  const { data: subAccounts = [] } = useQuery({
    queryKey: ["users"],
    enabled: canTransfer,
    queryFn: () => api<SubAccount[]>("/api/v1/users"),
  });

  const bulkMutation = useMutation<BulkResp>({
    mutationFn: () => {
      if (isRemove) {
        return api<{ count: number; emails: string[]; skipped: string[] }>(
          `/api/v1/workspaces/${workspaceId}/members/bulk-remove`,
          {
            method: "POST",
            body: JSON.stringify({ emails: validUnique }),
          },
        );
      }
      if (isTransfer) {
        return api<{ count: number; target_username: string }>(
          `/api/v1/added-members/transfer-owner`,
          {
            method: "POST",
            body: JSON.stringify({
              member_ids: foundMemberIds,
              target_user_id: targetUserId,
            }),
          },
        );
      }
      if (isUsageLimit) {
        // Tách email theo mức riêng (items) vs mức chung (emails + limit_credits).
        const items: { email: string; limit_credits: number }[] = [];
        const commonEmails: string[] = [];
        for (const lower of validUnique) {
          const own = creditsByEmail.get(lower);
          if (own !== undefined) items.push({ email: lower, limit_credits: own });
          else commonEmails.push(lower);
        }
        return api<{
          count: number;
          emails: string[];
          already?: string[];
          no_target?: string[];
          skipped: string[];
        }>(`/api/v1/workspaces/${workspaceId}/members/bulk-set-usage-limit`, {
          method: "POST",
          body: JSON.stringify({
            emails: commonEmails,
            items,
            ...(commonLimitSet ? { limit_credits: Number(commonLimitTrimmed) } : {}),
          }),
        });
      }
      const newLicenseType = action.slice("license:".length);
      return api<{
        count: number;
        emails: string[];
        already?: string[];
        skipped: string[];
      }>(`/api/v1/workspaces/${workspaceId}/members/bulk-change-license-type`, {
        method: "POST",
        body: JSON.stringify({
          emails: validUnique,
          new_license_type: newLicenseType,
        }),
      });
    },
    onSuccess: (resp) => {
      if ("target_username" in resp) {
        toast.success(
          t("bulkUpdate.transferOk", {
            n: resp.count,
            user: resp.target_username,
          }),
        );
        onDone();
        onClose();
        return;
      }
      toast.success(
        isRemove
          ? t("bulkRemove.resultQueued", { n: resp.count })
          : isUsageLimit
            ? resp.pending_approval
              ? t("bulkUsageLimit.resultPending", { n: resp.count })
              : t("bulkUsageLimit.resultQueued", { n: resp.count })
            : t("bulkLicense.resultQueued", { n: resp.count }),
      );
      if (resp.skipped.length > 0) {
        toast.error(
          t("bulkRemove.resultSkipped", {
            n: resp.skipped.length,
            list: resp.skipped.slice(0, 10).join(", "),
          }),
        );
      }
      onDone();
      onClose();
    },
    onError: (e) => {
      const msg =
        e instanceof ApiError
          ? String(e.detail)
          : e instanceof Error
            ? e.message
            : String(e);
      toast.error(t("bulkRemove.resultError", { error: msg }));
    },
  });

  // Gia hạn dùng endpoint riêng (/added-members/bulk-set-expiry) vì payload là
  // items:[{member_id, end_at}] + response {count, requested} khác các action kia.
  const renewMutation = useMutation<{ count: number; requested: boolean }>({
    mutationFn: () =>
      api<{ count: number; requested: boolean }>(
        `/api/v1/added-members/bulk-set-expiry`,
        { method: "POST", body: JSON.stringify({ items: renewItems }) },
      ),
    onSuccess: (resp) => {
      toast.success(
        resp.requested
          ? t("bulkRenew.resultRequested", { n: resp.count })
          : t("bulkRenew.resultQueued", { n: resp.count }),
      );
      // sub-admin tạo yêu cầu → làm mới badge chuông "duyệt đổi hạn".
      if (resp.requested)
        qc.invalidateQueries({ queryKey: ["subscription-requests"] });
      onDone();
      onClose();
    },
    onError: (e) => {
      const msg =
        e instanceof ApiError
          ? String(e.detail)
          : e instanceof Error
            ? e.message
            : String(e);
      toast.error(t("bulkRemove.resultError", { error: msg }));
    },
  });

  // Đang gửi (1 trong 2 mutation) → khoá input + nút.
  const submitting = bulkMutation.isPending || renewMutation.isPending;

  function removeEntry(emailLower: string) {
    setEmailsText((text) => {
      const lines = text.split(/\r?\n/);
      const kept: string[] = [];
      for (const line of lines) {
        const tokens = line.split(/[,;]/).map((s) => s.trim());
        const keptTokens = tokens.filter(
          (tok) => tok.toLowerCase() !== emailLower,
        );
        if (keptTokens.length === tokens.length) kept.push(line);
        else if (keptTokens.length > 0) kept.push(keptTokens.join(", "));
      }
      return kept.join("\n");
    });
  }

  // Số email khớp member (chỉ tin khi lookupReady) — dùng cho transfer.
  const matchedCount = lookupReady ? foundMemberIds.length : 0;
  const baseReady = validUnique.length > 0 && confirmed && !submitting;
  const canSubmit = isTransfer
    ? baseReady && !!targetUserId && matchedCount > 0
    : isUsageLimit
      ? baseReady && usageReady && canSetUsageLimit
      : isRenew
        ? baseReady && monthsValid && renewSelectedCount > 0
        : baseReady;

  const targetUsername =
    subAccounts.find((u) => u.id === targetUserId)?.username ??
    (user && targetUserId === user.id ? user.username : "");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full mx-4"
        style={{
          maxWidth: isRenew ? 1040 : 860,
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ padding: "16px 20px 8px", borderBottom: "1px solid var(--border)" }}>
          <div className="text-base font-semibold text-slate-900">
            {t("bulkUpdate.modalTitle")}
          </div>
          <p className="text-xs text-slate-500 mt-1">{t("bulkUpdate.modalSubtitle")}</p>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: isMobile ? "column" : "row",
            flex: 1,
            minHeight: 0,
          }}
        >
          {/* LEFT — paste textarea + counters */}
          <div
            style={{
              width: isMobile ? "100%" : 360,
              flexShrink: 0,
              padding: "12px 16px",
              borderRight: isMobile ? "none" : "1px solid var(--border)",
              borderBottom: isMobile ? "1px solid var(--border)" : "none",
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <label className="block text-xs font-medium text-slate-700 mb-1">
              {t("bulkUpdate.actionLabel")}
            </label>
            <select
              value={action}
              onChange={(e) => {
                setAction(e.target.value as BulkAction);
                setConfirmed(false);
              }}
              disabled={submitting}
              className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm mb-3 focus:outline-none focus:border-slate-900 disabled:opacity-60"
            >
              {canRemove && (
                <option value="remove">{t("bulkUpdate.actionRemove")}</option>
              )}
              {canRenew && (
                <option value="renew">{t("bulkUpdate.actionRenew")}</option>
              )}
              {canChangeLicense && (
                <option value="license:ChatGPT">
                  {t("bulkUpdate.actionLicenseChatGPT")}
                </option>
              )}
              {canChangeLicense && (
                <option value="license:Codex">
                  {t("bulkUpdate.actionLicenseCodex")}
                </option>
              )}
              {canTransfer && (
                <option value="transfer-owner">
                  {t("bulkUpdate.actionTransfer")}
                </option>
              )}
              {/* LUÔN hiển thị — chưa có quyền thì hiện thông báo + chặn submit. */}
              <option value="set-usage-limit">
                {t("bulkUpdate.actionUsageLimit")}
              </option>
            </select>
            {isUsageLimit && !canSetUsageLimit && (
              <div
                style={{
                  marginBottom: 12,
                  padding: "8px 10px",
                  borderRadius: 6,
                  background: "var(--warning-bg, #fffbeb)",
                  border: "1px solid var(--warning, #f59e0b)",
                  fontSize: 12,
                  color: "var(--ink-2, #475569)",
                }}
              >
                {t("usageLimit.needPermission")}
              </div>
            )}
            {isUsageLimit && canSetUsageLimit && (
              <div style={{ marginBottom: 12 }}>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t("bulkUsageLimit.commonLabel")}
                </label>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <input
                    type="number"
                    min={0}
                    max={MAX_LIMIT_CREDITS}
                    value={limitCreditsText}
                    onChange={(e) => {
                      setLimitCreditsText(e.target.value);
                      setConfirmed(false);
                    }}
                    placeholder={t("bulkUsageLimit.commonPlaceholder")}
                    disabled={submitting}
                    className="flex-1 border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-slate-900 disabled:opacity-60"
                  />
                  <span className="text-xs text-slate-500 whitespace-nowrap">
                    {t("bulkUsageLimit.unit")}
                  </span>
                </div>
                {!commonLimitValid && (
                  <div style={{ marginTop: 4, fontSize: 11, color: "var(--danger, #dc2626)" }}>
                    {t("bulkUsageLimit.commonInvalid")}
                  </div>
                )}
                <p style={{ marginTop: 4, fontSize: 11, color: "var(--ink-3)" }}>
                  {t("bulkUsageLimit.perMemberHint")}
                </p>
                {/* Ngân sách + ghi chú duyệt (chỉ sub-admin). super-admin: unlimited. */}
                {budget && !budget.unlimited && (
                  <div
                    style={{
                      marginTop: 8,
                      padding: "6px 8px",
                      borderRadius: 6,
                      background: "var(--warning-bg, #fffbeb)",
                      border: "1px solid var(--warning, #f59e0b)",
                      fontSize: 11,
                      color: "var(--ink-2, #475569)",
                    }}
                  >
                    <div>
                      {t("bulkUsageLimit.budgetInfo", {
                        used: budget.used,
                        budget: budget.budget,
                        remaining: budget.remaining,
                      })}
                    </div>
                    <div style={{ marginTop: 2 }}>
                      {t("bulkUsageLimit.approvalNote")}
                    </div>
                  </div>
                )}
              </div>
            )}
            {isRenew && (
              <div style={{ marginBottom: 12 }}>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t("bulkRenew.monthsLabel")}
                </label>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <input
                    type="number"
                    min={1}
                    value={monthsText}
                    onChange={(e) => {
                      setMonthsText(e.target.value);
                      setConfirmed(false);
                    }}
                    disabled={submitting}
                    className="flex-1 border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-slate-900 disabled:opacity-60"
                  />
                  <span className="text-xs text-slate-500 whitespace-nowrap">
                    {t("bulkRenew.monthsUnit")}
                  </span>
                </div>
                {!monthsValid && (
                  <div style={{ marginTop: 4, fontSize: 11, color: "var(--danger, #dc2626)" }}>
                    {t("bulkRenew.monthsInvalid")}
                  </div>
                )}
                <p style={{ marginTop: 4, fontSize: 11, color: "var(--ink-3)" }}>
                  {t("bulkRenew.hint")}
                </p>
                {!isSuper && (
                  <div
                    style={{
                      marginTop: 8,
                      padding: "6px 8px",
                      borderRadius: 6,
                      background: "var(--warning-bg, #fffbeb)",
                      border: "1px solid var(--warning, #f59e0b)",
                      fontSize: 11,
                      color: "var(--ink-2, #475569)",
                    }}
                  >
                    {t("bulkRenew.approvalNote")}
                  </div>
                )}
              </div>
            )}
            <label className="block text-xs font-medium text-slate-700 mb-1">
              {t("bulkRemove.pasteLabel")}
            </label>
            <textarea
              value={emailsText}
              onChange={(e) => setEmailsText(e.target.value)}
              placeholder={"user1@domain.com\nuser2@domain.com, user3@domain.com\n..."}
              disabled={submitting}
              spellCheck={false}
              autoFocus
              className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-slate-900 disabled:opacity-60"
              style={{ resize: "vertical", minHeight: 240, flex: 1 }}
            />
            <div
              style={{
                marginTop: 6,
                fontSize: 11,
                color: "var(--ink-3)",
                display: "flex",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <span style={{ color: "var(--success, #059669)" }}>
                ✓ {t("bulkRemove.parsed", { n: validUnique.length })}
              </span>
              {invalid.length > 0 && (
                <span style={{ color: "var(--danger, #dc2626)" }}>
                  ⚠ {t("bulkRemove.invalidFormat", { n: invalid.length })}
                </span>
              )}
              {duplicates.length > 0 && (
                <span style={{ color: "var(--warning, #d97706)" }}>
                  ⚠ {t("bulkRemove.duplicateSkipped", { n: duplicates.length })}
                </span>
              )}
            </div>
          </div>

          {/* RIGHT — transfer target (nếu chuyển chủ) + bảng thông tin */}
          <div
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            {isTransfer && (
              <div
                style={{
                  padding: "10px 20px",
                  borderBottom: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <label className="text-xs font-medium text-slate-700">
                  {t("bulkUpdate.transferTargetLabel")}
                </label>
                <select
                  value={targetUserId}
                  disabled={submitting}
                  onChange={(e) => {
                    setTargetUserId(e.target.value);
                    setConfirmed(false);
                  }}
                  className="border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-slate-900 disabled:opacity-60"
                  style={{ minWidth: 200 }}
                >
                  <option value="">{t("bulkUpdate.transferTargetPlaceholder")}</option>
                  {user && (
                    <option value={user.id}>
                      {t("bulkUpdate.transferToAdmin", { user: user.username })}
                    </option>
                  )}
                  {subAccounts
                    .filter((u) => u.id !== user?.id)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.username}
                      </option>
                    ))}
                </select>
              </div>
            )}

            {validUnique.length === 0 ? (
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 24,
                  fontSize: 12,
                  color: "var(--ink-3)",
                  textAlign: "center",
                }}
              >
                {t("bulkRemove.pasteHint")}
              </div>
            ) : isRenew ? (
              <div style={{ flex: 1, overflow: "auto" }}>
                <table
                  style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}
                >
                  <thead>
                    <tr
                      style={{
                        textAlign: "left",
                        color: "var(--ink-3)",
                        borderBottom: "1px solid var(--border)",
                      }}
                    >
                      <th style={{ padding: "8px 8px 8px 20px", fontWeight: 500, width: 28 }}>
                        <input
                          type="checkbox"
                          checked={renewAllSelected}
                          onChange={toggleRenewAll}
                          disabled={submitting || renewMatchedLowers.length === 0}
                          title={t("bulkRenew.selectAll")}
                        />
                      </th>
                      <th style={{ padding: "8px", fontWeight: 500 }}>
                        {t("bulkUpdate.colEmail")}
                      </th>
                      <th style={{ padding: "8px", fontWeight: 500 }}>
                        {t("bulkRenew.colRenewDate")}
                      </th>
                      <th style={{ padding: "8px", fontWeight: 500 }}>
                        {t("bulkRenew.colCurrentExpiry")}
                      </th>
                      <th style={{ padding: "8px", fontWeight: 500 }}>
                        {t("bulkRenew.colNewExpiry")}
                      </th>
                      <th style={{ padding: "8px 20px 8px 8px" }} />
                    </tr>
                  </thead>
                  <tbody>
                    {renewComputed.map((r) => {
                      const missing = lookupReady && !r.matched;
                      return (
                        <tr
                          key={r.lower}
                          style={{
                            borderBottom: "1px solid var(--border)",
                            color: missing ? "var(--ink-3)" : "var(--ink, #0f172a)",
                            opacity: missing ? 0.6 : 1,
                          }}
                        >
                          <td style={{ padding: "6px 8px 6px 20px" }}>
                            {r.matched && (
                              <input
                                type="checkbox"
                                checked={r.selected}
                                onChange={() => toggleRenewRow(r.lower)}
                                disabled={submitting}
                              />
                            )}
                          </td>
                          <td
                            style={{
                              padding: "6px 8px",
                              fontFamily: "var(--font-mono)",
                              maxWidth: 200,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                            title={r.emailRaw}
                          >
                            {r.emailRaw}
                          </td>
                          <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>
                            {r.matched ? (
                              <input
                                type="date"
                                value={toDateInputValue(r.start)}
                                onChange={(e) => setRenewStart(r.lower, e.target.value)}
                                disabled={submitting}
                                className="border border-slate-300 rounded px-1 py-0.5 text-xs focus:outline-none focus:border-slate-900 disabled:opacity-50"
                              />
                            ) : missing ? (
                              t("bulkUpdate.lookupNotFound")
                            ) : (
                              "…"
                            )}
                          </td>
                          <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>
                            {r.matched
                              ? r.currentEnd
                                ? formatDate(r.currentEnd.toISOString())
                                : "—"
                              : ""}
                          </td>
                          <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>
                            {r.matched && (
                              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                  <input
                                    type="date"
                                    value={toDateInputValue(r.newEnd)}
                                    onChange={(e) => setRenewEnd(r.lower, e.target.value)}
                                    disabled={submitting}
                                    className="border border-slate-300 rounded px-1 py-0.5 text-xs focus:outline-none focus:border-slate-900 disabled:opacity-50"
                                    style={{ color: "var(--success, #059669)" }}
                                  />
                                  {/* "+" → mở ô nhập số tháng/ngày RIÊNG cho email này. */}
                                  <button
                                    type="button"
                                    onClick={() => toggleRenewDur(r.lower)}
                                    disabled={submitting}
                                    title={t("bulkRenew.customDurHint")}
                                    className="flex items-center justify-center rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                                    style={{
                                      width: 22,
                                      height: 22,
                                      fontSize: 15,
                                      lineHeight: 1,
                                      flexShrink: 0,
                                      background: r.durOverride
                                        ? "var(--surface-2, #f1f5f9)"
                                        : "none",
                                    }}
                                  >
                                    {r.durOverride ? "−" : "+"}
                                  </button>
                                </div>
                                {r.durOverride && (
                                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                    <input
                                      type="number"
                                      min={0}
                                      value={r.durOverride.months}
                                      onChange={(e) => setRenewDur(r.lower, "months", e.target.value)}
                                      disabled={submitting}
                                      className="border border-slate-300 rounded px-1 py-0.5 text-xs focus:outline-none focus:border-slate-900 disabled:opacity-50"
                                      style={{ width: 42 }}
                                    />
                                    <span className="text-xs text-slate-500">
                                      {t("bulkRenew.monthsUnit")}
                                    </span>
                                    <input
                                      type="number"
                                      min={0}
                                      value={r.durOverride.days}
                                      onChange={(e) => setRenewDur(r.lower, "days", e.target.value)}
                                      disabled={submitting}
                                      className="border border-slate-300 rounded px-1 py-0.5 text-xs focus:outline-none focus:border-slate-900 disabled:opacity-50"
                                      style={{ width: 42 }}
                                    />
                                    <span className="text-xs text-slate-500">
                                      {t("bulkRenew.daysUnit")}
                                    </span>
                                  </div>
                                )}
                              </div>
                            )}
                          </td>
                          <td style={{ padding: "6px 20px 6px 8px", textAlign: "right" }}>
                            <button
                              onClick={() => removeEntry(r.lower)}
                              disabled={submitting}
                              className="text-slate-400 hover:text-rose-600 disabled:opacity-40"
                              title={t("bulkRemove.removeRow")}
                              style={{
                                fontSize: 16,
                                lineHeight: 1,
                                background: "none",
                                border: "none",
                              }}
                            >
                              ×
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {lookupReady && (lookup?.not_found.length ?? 0) > 0 && (
                  <div
                    style={{
                      padding: "8px 20px",
                      fontSize: 11,
                      color: "var(--warning, #d97706)",
                    }}
                  >
                    ⚠ {t("bulkUpdate.lookupMatchSummary", {
                      found: foundMemberIds.length,
                      missing: lookup?.not_found.length ?? 0,
                    })}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ flex: 1, overflow: "auto" }}>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: 12,
                  }}
                >
                  <thead>
                    <tr
                      style={{
                        textAlign: "left",
                        color: "var(--ink-3)",
                        borderBottom: "1px solid var(--border)",
                      }}
                    >
                      <th style={{ padding: "8px 8px 8px 20px", fontWeight: 500 }}>
                        {t("bulkUpdate.colEmail")}
                      </th>
                      <th style={{ padding: "8px", fontWeight: 500 }}>
                        {t("bulkUpdate.colAdded")}
                      </th>
                      <th style={{ padding: "8px", fontWeight: 500 }}>
                        {isUsageLimit
                          ? t("bulkUsageLimit.colCurrent")
                          : t("bulkUpdate.colExpiry")}
                      </th>
                      <th style={{ padding: "8px", fontWeight: 500 }}>
                        {isUsageLimit
                          ? t("bulkUsageLimit.colNew")
                          : t("bulkUpdate.colOwner")}
                      </th>
                      <th style={{ padding: "8px 20px 8px 8px" }} />
                    </tr>
                  </thead>
                  <tbody>
                    {validRaw.map((emailRaw, idx) => {
                      const lower = validUnique[idx];
                      const row = foundByEmail.get(lower);
                      const missing = lookupReady && !row;
                      return (
                        <tr
                          key={lower}
                          style={{
                            borderBottom: "1px solid var(--border)",
                            color: missing
                              ? "var(--ink-3)"
                              : "var(--ink, #0f172a)",
                            opacity: missing ? 0.6 : 1,
                          }}
                        >
                          <td
                            style={{
                              padding: "6px 8px 6px 20px",
                              fontFamily: "var(--font-mono)",
                              maxWidth: 220,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                            title={emailRaw}
                          >
                            {emailRaw}
                          </td>
                          <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>
                            {row
                              ? formatDate(row.added_at)
                              : missing
                                ? t("bulkUpdate.lookupNotFound")
                                : "…"}
                          </td>
                          <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>
                            {isUsageLimit
                              ? row
                                ? row.usage_limit_credits == null
                                  ? t("bulkUsageLimit.notSet")
                                  : row.usage_limit_credits
                                : ""
                              : row
                                ? row.subscription_end_at
                                  ? formatDate(row.subscription_end_at)
                                  : "—"
                                : ""}
                          </td>
                          <td
                            style={{
                              padding: "6px 8px",
                              maxWidth: 140,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                            title={isUsageLimit ? "" : row?.owner_username ?? ""}
                          >
                            {isUsageLimit
                              ? (() => {
                                  const own = creditsByEmail.get(lower);
                                  const target =
                                    own !== undefined
                                      ? own
                                      : commonLimitSet
                                        ? Number(commonLimitTrimmed)
                                        : null;
                                  return target == null ? "—" : target;
                                })()
                              : row
                                ? row.owner_username ?? t("bulkUpdate.noOwner")
                                : ""}
                          </td>
                          <td style={{ padding: "6px 20px 6px 8px", textAlign: "right" }}>
                            <button
                              onClick={() => removeEntry(lower)}
                              disabled={submitting}
                              className="text-slate-400 hover:text-rose-600 disabled:opacity-40"
                              title={t("bulkRemove.removeRow")}
                              style={{
                                fontSize: 16,
                                lineHeight: 1,
                                background: "none",
                                border: "none",
                              }}
                            >
                              ×
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {lookupReady && (lookup?.not_found.length ?? 0) > 0 && (
                  <div
                    style={{
                      padding: "8px 20px",
                      fontSize: 11,
                      color: "var(--warning, #d97706)",
                    }}
                  >
                    ⚠ {t("bulkUpdate.lookupMatchSummary", {
                      found: foundMemberIds.length,
                      missing: lookup?.not_found.length ?? 0,
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div
          style={{
            padding: "12px 20px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
          }}
        >
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12,
              color: isRemove ? "var(--danger, #dc2626)" : "var(--ink-2, #475569)",
              cursor: validUnique.length > 0 ? "pointer" : "default",
            }}
          >
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              disabled={validUnique.length === 0 || submitting}
            />
            {isRemove
              ? t("bulkRemove.confirmCheckbox", { n: validUnique.length })
              : isTransfer
                ? t("bulkUpdate.confirmTransfer", {
                    n: matchedCount,
                    user: targetUsername || "…",
                  })
                : isUsageLimit
                  ? t("bulkUsageLimit.confirmCheckbox", { n: validUnique.length })
                  : isRenew
                    ? isSuper
                      ? t("bulkRenew.confirmCheckbox", { n: renewSelectedCount })
                      : t("bulkRenew.confirmCheckboxRequest", {
                          n: renewSelectedCount,
                        })
                    : t("bulkUpdate.confirmLicense", {
                        n: validUnique.length,
                        license: action.slice("license:".length),
                      })}
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={onClose}
              disabled={submitting}
              className="px-3 py-1.5 rounded text-sm border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-60"
            >
              {t("common.cancel")}
            </button>
            <button
              onClick={() =>
                isRenew ? renewMutation.mutate() : bulkMutation.mutate()
              }
              disabled={!canSubmit}
              className={
                isRemove
                  ? "px-3 py-1.5 rounded text-sm bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-60"
                  : "px-3 py-1.5 rounded text-sm bg-slate-900 text-white hover:bg-slate-700 disabled:opacity-60"
              }
            >
              {submitting
                ? isRenew
                  ? t("bulkRenew.submitBusy")
                  : t("bulkRemove.submitBusy")
                : isRemove
                  ? t("bulkRemove.submit", { n: validUnique.length })
                  : isTransfer
                    ? t("bulkUpdate.submitTransfer", { n: matchedCount })
                    : isUsageLimit
                      ? t("bulkUsageLimit.submit", { n: validUnique.length })
                      : isRenew
                        ? isSuper
                          ? t("bulkRenew.submit", { n: renewSelectedCount })
                          : t("bulkRenew.submitRequest", { n: renewSelectedCount })
                        : t("bulkUpdate.submitLicense", {
                            n: validUnique.length,
                            license: action.slice("license:".length),
                          })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
