/**
 * Nút "Xuất báo cáo" của trang Ví (và trang Quản trị Ví) — menu 2 định dạng.
 *
 * `.xlsx` là mặc định: 4 sheet, số cộng được, dải ngày và dòng cộng rõ ràng. `.csv`
 * giữ lại cho ai cần nạp vào phần mềm kế toán — phẳng, mỗi bút toán một dòng.
 *
 * Dữ liệu tiền KHÔNG bám bộ lọc màn hình: nút này tự kéo toàn bộ bút toán của kỳ
 * đang xem. Trang Ví giấu bớt cho gọn (lượt mời lỗi, khoản hoàn đã bị lượt sau tiêu
 * hết), nhưng sổ tiền có cột số dư chạy mà thiếu dòng thì số dư nhảy vô cớ.
 *
 * Sheet "Email trong ngày" cần thêm trạng thái thành viên + chuỗi ĐỔI EMAIL, thứ
 * sổ ví không có. Hai thứ đó nằm ở `/added-members`, và chuỗi đổi email CHỈ được
 * backend đổ đầy ở danh sách `?removed=true` (xem added_members.md) nên phải gọi cả
 * hai danh sách rồi trộn. Chỉ gọi lúc bấm xuất, không tải sẵn theo trang.
 */
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { WalletHistoryState } from "./WalletHistory";
import { secondaryBtn } from "./walletUi";
import { api } from "../lib/api";
import type { AddedMember } from "../types";
import type { WalletTxn } from "../lib/wallet";
import {
  buildTxnRows,
  closingBalanceByDay,
  groupRowsByDay,
  traceRefundUsage,
} from "../lib/wallet-history";
import {
  buildWalletReport,
  downloadReportCsv,
  downloadReportXlsx,
  type MemberInfo,
} from "../lib/wallet-report";

/** Trần số trang kéo về (100 bút toán/trang) — chặn khoảng ngày vô lý làm treo trình duyệt. */
const MAX_PAGES = 40;

/**
 * Kéo TOÀN BỘ bút toán của kỳ đang xem, không dừng ở trang đầu.
 *
 * Màn hình chỉ tải 100 bút toán rồi cuộn thêm, nên nếu báo cáo dùng lại đúng chỗ đó
 * thì ngày nào đông là file lặng lẽ cụt — mà cụt sổ tiền thì không ai nhìn ra.
 */
async function fetchAllTxns(day: string | null, userId: string | null): Promise<WalletTxn[]> {
  const out: WalletTxn[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({ limit: "500" });
    if (day) qs.set("date", day);
    if (cursor) qs.set("before_seq", cursor);
    const res: { items: WalletTxn[]; next_cursor: string | null } = await api(
      userId
        ? `/api/v1/wallet/admin/users/${userId}/transactions?${qs}`
        : `/api/v1/wallet/transactions?${qs}`,
    );
    out.push(...res.items);
    if (!res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return out;
}

/** Tải + trộn 2 danh sách email đã add. Lỗi thì trả rỗng — báo cáo vẫn xuất được,
 *  chỉ thiếu mấy cột thành viên (sheet tự ghi rõ là thiếu). */
async function fetchMembers(
  qc: ReturnType<typeof useQueryClient>,
  userId: string | null,
): Promise<MemberInfo[]> {
  const q = userId ? `?user_id=${encodeURIComponent(userId)}` : "";
  const removedQ = userId ? `${q}&removed=true` : "?removed=true";
  try {
    const [live, removed] = await Promise.all([
      qc.fetchQuery({
        queryKey: userId ? ["added-members", "by-user", userId] : ["added-members", "self"],
        queryFn: () => api<AddedMember[]>(`/api/v1/added-members${q}`),
        staleTime: 60_000,
      }),
      qc.fetchQuery({
        queryKey: ["added-members", "removed", userId ?? "self"],
        queryFn: () => api<AddedMember[]>(`/api/v1/added-members${removedQ}`),
        staleTime: 60_000,
      }),
    ]);
    // Dòng "đã xoá" đứng SAU để bản mang chuỗi đổi email ghi đè bản không có.
    return [...live, ...removed] as MemberInfo[];
  } catch {
    return [];
  }
}

export default function WalletExportButton({
  s,
  day,
  owner,
  userId = null,
}: {
  s: WalletHistoryState;
  day: string | null;
  owner: string;
  /** Đang xem ví của tài khoản khác (trang Quản trị Ví). null = ví của chính mình. */
  userId?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  const empty = s.groups.length === 0;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  async function pick(kind: "xlsx" | "csv") {
    setOpen(false);
    setBusy(true);
    try {
      // CSV chỉ có phần tiền nên khỏi gọi thêm danh sách email.
      const members = kind === "xlsx" ? await fetchMembers(qc, userId) : [];
      // Báo cáo KHÔNG đi qua bộ lọc của màn hình. Trang Ví cố tình giấu khoản hoàn đã
      // bị lượt sau tiêu hết (coi như triệt tiêu) và giấu lượt mời lỗi — nhìn thì gọn,
      // nhưng sổ có cột số dư chạy mà thiếu dòng thì thành tiền từ đâu rơi ra: ví
      // hdh2102 ngày 30/8 nhảy từ 0 lên 3.960.000 giữa hai dòng, không gì giải thích
      // (user 2026-08-30: "tiền vào vẫn sai?"). Sổ tiền phải đủ dòng hoặc vô dụng.
      const items = await fetchAllTxns(day, userId);
      const rows = buildTxnRows(items);
      const report = buildWalletReport({
        owner,
        items,
        groups: groupRowsByDay(rows, { day, showVoided: true }),
        closing: closingBalanceByDay(items),
        trace: traceRefundUsage(rows),
        channel: null,
        showVoided: true,
        day,
        members,
        now: new Date(),
      });
      if (kind === "xlsx") downloadReportXlsx(report);
      else downloadReportCsv(report);
    } finally {
      setBusy(false);
    }
  }

  const disabled = empty || busy;
  return (
    <div ref={box} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        style={{ ...secondaryBtn, opacity: disabled ? 0.5 : 1 }}
      >
        {busy ? "Đang dựng file…" : "Xuất báo cáo ▾"}
      </button>
      {open && !disabled && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            zIndex: 30,
            minWidth: 244,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "var(--shadow-card)",
            padding: 5,
          }}
        >
          <MenuItem
            title="Excel (.xlsx)"
            desc="Tổng quan · Chi tiết lệnh · Theo email · Email trong ngày"
            onClick={() => void pick("xlsx")}
          />
          <MenuItem
            title="CSV"
            desc="Bảng phẳng để nạp vào phần mềm khác"
            onClick={() => void pick("csv")}
          />
        </div>
      )}
    </div>
  );
}

function MenuItem({
  title,
  desc,
  onClick,
}: {
  title: string;
  desc: string;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        border: "none",
        background: hover ? "var(--surface-2)" : "transparent",
        borderRadius: 8,
        padding: "9px 11px",
        cursor: "pointer",
        fontFamily: "inherit",
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{title}</div>
      <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 2 }}>{desc}</div>
    </button>
  );
}
