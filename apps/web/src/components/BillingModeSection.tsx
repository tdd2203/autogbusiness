/**
 * Khối GẠT CHẾ ĐỘ TÍNH HẠN của một không gian (trang Cài đặt, chỉ super-admin).
 *
 * Đây là chỗ DUY NHẤT trong dashboard hiện và đổi được chế độ tính hạn. Cố ý không
 * rải thêm nút ở trang danh sách hay panel thanh toán: đổi chế độ là đổi cách tính
 * hạn dùng lẫn số tiền của MỌI lần bán sau đó, càng nhiều chỗ bấm được thì càng dễ
 * có ngày ai đó gạt nhầm trong lúc đang làm việc khác.
 *
 * Hai chế độ:
 *   - "legacy_30d": mỗi lần bán tính 30 ngày kể từ lúc mua, mỗi email một mốc riêng.
 *   - "cycle_aligned": hạn của mọi email rơi đúng mốc chốt chu kỳ hoá đơn của
 *     không gian, nên cần biết NGÀY CHỐT (1–31).
 *
 * Nút gạt luôn đi qua hộp xác nhận nói rõ hậu quả bằng lời thường: người đang có
 * hạn KHÔNG bị đụng tới, chỉ những lần bán từ đây về sau mới đổi. Câu chữ ở đây chỉ
 * nói kết quả người dùng thấy được, không kể cơ chế bên trong.
 *
 * Lỗi API (bốn chốt chặn phía server, mỗi cái một câu tiếng Việt) hiện thẳng trong
 * khối và NẰM LẠI đó, không dùng toast tự tắt: người gạt cần đọc kỹ rồi sửa ô nhập.
 */

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, apiErrorText } from "../lib/api";
import { useT } from "../i18n";
import { confirm, toast } from "./Toast";
import type { BillingMode, Workspace } from "../types";

/** Khoảng ngày hợp lệ — khớp với chốt chặn cùng tên bên API. Chặn sẵn ở đây để
 *  người gõ nhầm nhận câu trả lời ngay, khỏi mất một lượt gọi mạng. */
const CYCLE_DAY_MIN = 1;
const CYCLE_DAY_MAX = 31;

/** Ngày trong tháng của mốc gia hạn đang có, đọc theo GIỜ UTC.
 *
 * PHẢI là UTC: API suy ngày chốt từ chính cột này theo giờ UTC, đọc theo giờ máy
 * người dùng thì màn hình hứa một ngày còn hệ thống chạy một ngày khác — lệch một
 * ngày ở đây là lệch hạn của mọi email trong không gian.
 */
function renewalDay(renewalDate: string | null): number | null {
  if (!renewalDate) return null;
  const d = new Date(renewalDate);
  return Number.isNaN(d.getTime()) ? null : d.getUTCDate();
}

export function BillingModeSection({ workspace }: { workspace: Workspace }) {
  const t = useT();
  const qc = useQueryClient();

  const isCycle = workspace.billing_mode === "cycle_aligned";
  const target: BillingMode = isCycle ? "legacy_30d" : "cycle_aligned";
  // Ngày chốt hệ thống đang biết: ưu tiên ngày đã lưu, chưa có thì suy từ mốc gia
  // hạn của hoá đơn gần nhất. Cả hai đều trống nghĩa là hệ thống CHƯA BIẾT — lúc đó
  // ô nhập là bắt buộc, không thì gạt xong mọi lượt bán đều tắc.
  const knownDay = workspace.cycle_anchor_day ?? renewalDay(workspace.renewal_date);

  const [anchor, setAnchor] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Ô sửa ngày chốt cho không gian ĐANG chạy chế độ chu kỳ — tách khỏi ô của luồng
  // gạt chế độ ở trên, vì hai việc khác nhau: một cái đổi cách tính tiền, một cái
  // chỉ chỉnh con số. Dùng chung một ô là gõ cho việc này lại gửi kèm việc kia.
  const [anchorEdit, setAnchorEdit] = useState("");

  // Ô nhập điền sẵn ngày hệ thống đang biết để người gạt thấy mình sắp chốt vào ngày
  // nào, sửa lại được nếu sai. Nạp lại khi workspace được tải/làm mới.
  useEffect(() => {
    setAnchor(knownDay == null ? "" : String(knownDay));
  }, [knownDay]);

  const save = useMutation({
    mutationFn: (body: { mode: BillingMode; cycle_anchor_day?: number }) =>
      api<Workspace>(`/api/v1/workspaces/${workspace.id}/billing-mode`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      setError(null);
      toast.success(t("billingMode.saved"));
      // Số liệu trên màn đổi ngay sau khi gạt (chế độ, ngày chốt, và các trang khác
      // đọc workspace) nên phải tự nạp lại — không bắt người dùng F5.
      qc.invalidateQueries({ queryKey: ["workspace", workspace.id] });
      qc.invalidateQueries({ queryKey: ["workspaces"] });
    },
    // Câu từ chối của API là câu tiếng Việt nói rõ sai chỗ nào, giữ nguyên trên màn
    // hình thay vì nuốt đi.
    onError: (e) => setError(apiErrorText(e, t("billingMode.saveError"))),
  });

  async function onSwitch() {
    setError(null);
    const raw = anchor.trim();
    let day: number | undefined;
    if (target === "cycle_aligned") {
      if (raw) {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < CYCLE_DAY_MIN || n > CYCLE_DAY_MAX) {
          setError(t("billingMode.anchorInvalid", { min: CYCLE_DAY_MIN, max: CYCLE_DAY_MAX }));
          return;
        }
        day = n;
      } else if (knownDay == null) {
        setError(t("billingMode.anchorRequired"));
        return;
      }
    }

    const dayShown = day ?? knownDay;
    const ok = await confirm(
      target === "cycle_aligned"
        ? t("billingMode.confirmToCycle", { ngay: dayShown ?? "?" })
        : t("billingMode.confirmToLegacy"),
      {
        title: t("billingMode.confirmTitle"),
        okText: t("billingMode.confirmOk"),
        cancelText: t("common.cancel"),
        danger: true,
      },
    );
    if (!ok) return;

    // Chỉ gửi ngày chốt khi người dùng thực sự có số trong ô. Bỏ trống thì để API
    // giữ/suy ngày như cũ; hai trường ghi đè còn lại không gửi = không đụng tới.
    save.mutate(day == null ? { mode: target } : { mode: target, cycle_anchor_day: day });
  }

  async function onSaveAnchor() {
    setError(null);
    const n = Number(anchorEdit.trim());
    if (!Number.isInteger(n) || n < CYCLE_DAY_MIN || n > CYCLE_DAY_MAX) {
      setError(t("billingMode.anchorInvalid", { min: CYCLE_DAY_MIN, max: CYCLE_DAY_MAX }));
      return;
    }
    const ok = await confirm(t("billingMode.confirmAnchorChange", { ngay: n }), {
      title: t("billingMode.anchorEditTitle"),
      okText: t("billingMode.confirmOk"),
      cancelText: t("common.cancel"),
      danger: true,
    });
    if (!ok) return;
    save.mutate({ mode: "cycle_aligned", cycle_anchor_day: n });
  }

  return (
    <section className="settings-section" style={{ marginBottom: 20 }}>
      <h3 className="display-h3">{t("billingMode.title")}</h3>
      <p style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 4, marginBottom: 16 }}>
        {t("billingMode.desc")}
      </p>

      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: 14,
          background: "var(--bg)",
          marginBottom: 16,
        }}
      >
        <div
          style={{
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--ink-3)",
            fontWeight: 500,
          }}
        >
          {t("billingMode.current")}
        </div>
        <div style={{ fontSize: 15, fontWeight: 600, color: "var(--ink)", marginTop: 4 }}>
          {t(isCycle ? "billingMode.cycleName" : "billingMode.legacyName")}
        </div>
        <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginTop: 4, lineHeight: 1.5 }}>
          {t(isCycle ? "billingMode.cycleHint" : "billingMode.legacyHint")}
        </div>
        {isCycle && (
          <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 8 }}>
            {workspace.cycle_anchor_day != null
              ? t("billingMode.anchorCurrent", { ngay: workspace.cycle_anchor_day })
              : t("billingMode.anchorMissing")}
          </div>
        )}
      </div>

      {target === "cycle_aligned" && (
        <div style={{ marginBottom: 16 }}>
          <label className="form-label" htmlFor="cycle-anchor-day">
            {t("billingMode.anchorLabel")}
          </label>
          <input
            id="cycle-anchor-day"
            type="number"
            min={CYCLE_DAY_MIN}
            max={CYCLE_DAY_MAX}
            value={anchor}
            onChange={(e) => setAnchor(e.target.value)}
            className="form-input"
            style={{ maxWidth: 160 }}
          />
          <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginTop: 6, lineHeight: 1.5 }}>
            {knownDay == null
              ? t("billingMode.anchorHintUnknown")
              : t("billingMode.anchorHintKnown", { ngay: knownDay })}
          </div>
        </div>
      )}

      {error && (
        <div
          style={{
            border: "1px solid var(--danger)",
            borderRadius: 10,
            padding: "10px 12px",
            fontSize: 13,
            lineHeight: 1.55,
            color: "var(--danger)",
            marginBottom: 12,
          }}
        >
          {error}
        </div>
      )}

      {/* Đang chạy chế độ chu kỳ thì vẫn phải sửa được ngày chốt. ChatGPT đổi ngày
          chốt thật là chuyện có xảy ra; không có ô này thì cách duy nhất để chữa là
          gạt về chế độ cũ rồi gạt lại — đổi cách tính tiền hai lần chỉ để sửa một
          con số. */}
      {isCycle && (
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: 12,
            padding: 14,
            marginBottom: 16,
          }}
        >
          <label className="form-label" htmlFor="cycle-anchor-edit">
            {t("billingMode.anchorEditTitle")}
          </label>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
            <input
              id="cycle-anchor-edit"
              type="number"
              min={CYCLE_DAY_MIN}
              max={CYCLE_DAY_MAX}
              placeholder={String(workspace.cycle_anchor_day ?? "")}
              value={anchorEdit}
              onChange={(e) => setAnchorEdit(e.target.value)}
              className="form-input"
              style={{ maxWidth: 120 }}
            />
            <button
              type="button"
              onClick={onSaveAnchor}
              disabled={save.isPending || !anchorEdit.trim()}
              className="btn"
            >
              {t("billingMode.anchorEditSave")}
            </button>
          </div>
          <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginTop: 6, lineHeight: 1.5 }}>
            {t("billingMode.anchorEditHint")}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={onSwitch}
        disabled={save.isPending}
        className="btn btn-primary"
      >
        {save.isPending
          ? t("common.saving")
          : t(target === "cycle_aligned" ? "billingMode.switchToCycle" : "billingMode.switchToLegacy")}
      </button>
    </section>
  );
}
