/**
 * Modal cấu hình ĐÍCH MỜI theo từng user (nút ⚙️ trang "Mời thành viên", super-admin).
 *
 * Mỗi sub-admin 1 dòng: chọn "Toàn bộ" (được add email mới vào MỌI workspace, kể cả tạo
 * mới sau này) hoặc "Chỉ định" (tick từng workspace). Khi user đó add email MỚI, trang
 * Mời chọn NGẪU NHIÊN 1 workspace trong tập đã bật (email cũ/gia hạn giữ ws lịch sử).
 *
 * "Chỉ định" mà bỏ trống hết là trạng thái HỢP LỆ, lưu được: user đó bị TẠM NGƯNG add
 * email mới (trang Mời hiện thông báo tạm ngưng, backend cũng chặn vì hết assignment).
 * Thanh trên cho áp dụng hàng loạt cho mọi dòng đang hiện, mỗi dòng có thêm "Áp dụng
 * cho tất cả" để nhân cấu hình vừa chỉnh sang những người còn lại.
 *
 * Sửa bao nhiêu dòng cũng được, thanh dưới đếm số thay đổi rồi lưu 1 lần qua
 * PUT /api/v1/invite-config/users/{id} (mỗi user 1 request, chạy song song).
 * Dùng chung bảng workspace_assignments với màn "Assign" ở trang Workspaces
 * (giữ credit_budget của record sẵn có).
 *
 * Khối TRẦN THÀNH VIÊN ở đầu modal là chuyện KHÁC (theo WORKSPACE, không theo user):
 * super-admin gõ số suất đã mua thật cho từng không gian + ngày sẽ mở lại. Chạm trần
 * thì mọi lệnh mời vào đó dừng lại. Để trống = không chặn, 0 = ngưng hẳn.
 *
 * Câu thông báo là MỘT câu dùng chung mọi không gian, soạn ngay trong khối đó, có chỗ
 * thay động {conlai}/{ngay}/{ten}. Ba thứ lưu chung một nút Lưu ở thanh dưới nhưng đi
 * hai đường: PATCH /api/v1/workspaces/{id} (trần + ngày) và
 * PUT /api/v1/admin/invite-settings (câu chữ).
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n";
import { invalidateWorkspaceSeats, useSeatMap } from "../hooks/useWorkspaceSeats";
import { confirm, toast } from "./Toast";
import { SEAT_TOTAL_MAX, type Workspace } from "../types";

type InviteConfigUser = {
  user_id: string;
  email: string;
  username: string;
  is_active: boolean;
  all_workspaces: boolean;
  workspace_ids: string[];
};

type Draft = { all: boolean; ids: Set<string> };

/** Nghĩa của từng chỗ thay động, dịch ở FE — backend vẫn là nguồn DANH SÁCH token
 *  (thêm token mới ở backend là giao diện tự hiện, chỉ thiếu bản dịch thì rơi về
 *  câu tiếng Việt kèm theo API). */
const TOKEN_HINT_KEY: Record<string, string | undefined> = {
  "{conlai}": "inviteConfig.capTokenLeft",
  "{ngay}": "inviteConfig.capTokenDate",
  "{ten}": "inviteConfig.capTokenName",
};

type InviteSettings = {
  cap_message: string | null;
  default_message: string;
  placeholders: { token: string; hint: string }[];
};

/** Ô tìm kiếm chỉ có ích khi danh sách đủ dài. */
const SEARCH_MIN_USERS = 6;
/** 1 workspace thì bấm thẳng vào chip nhanh hơn, khỏi bày nút Chọn hết / Bỏ hết. */
const BULK_CHIP_MIN = 2;

export default function InviteWorkspaceConfigModal({
  onClose,
}: {
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();

  // Chỉ gọi DB khi mở modal (mount) + sau khi Lưu (invalidate). Cache 2′ để mở lại
  // ngay không gọi thừa. Không polling, không refetch on focus (mặc định global).
  const configQ = useQuery({
    queryKey: ["invite-config"],
    queryFn: () => api<InviteConfigUser[]>("/api/v1/invite-config/users"),
    staleTime: 2 * 60_000,
  });
  const settingsQ = useQuery({
    queryKey: ["invite-settings"],
    queryFn: () => api<InviteSettings>("/api/v1/admin/invite-settings"),
    staleTime: 2 * 60_000,
  });
  const workspacesQ = useQuery({
    // Cấu hình đích của trang Mời nhánh ChatGPT (nút ⚙️ chỉ hiện ở nhánh đó).
    queryKey: ["workspaces", "gpt"],
    queryFn: () => api<Workspace[]>("/api/v1/workspaces?platform=gpt"),
    staleTime: 2 * 60_000,
  });

  const workspaces = workspacesQ.data ?? [];
  const subAdmins = useMemo(() => configQ.data ?? [], [configQ.data]);

  const [query, setQuery] = useState("");

  // ── TRẦN THÀNH VIÊN theo workspace (ô nhập giữ CHUỖI để gõ dở/xoá trắng được) ──
  const [capDraft, setCapDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!workspacesQ.data) return;
    setCapDraft((prev) => {
      const next = { ...prev };
      for (const w of workspacesQ.data!) {
        if (next[w.id] === undefined) {
          next[w.id] = w.invite_member_cap == null ? "" : String(w.invite_member_cap);
        }
      }
      return next;
    });
  }, [workspacesQ.data]);
  /** Chuỗi trong ô → giá trị gửi lên. Trắng = null (bỏ trần). Kẹp về [0, 999] để
   *  backend không phải từ chối một con số người ta gõ nhầm thừa số 0. */
  const capValue = (raw: string | undefined): number | null => {
    const v = (raw ?? "").trim();
    if (!v) return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(SEAT_TOTAL_MAX, Math.floor(n)));
  };
  // ── NGÀY MỞ LẠI theo workspace (chuỗi YYYY-MM-DD của <input type="date">) ──
  const [dayDraft, setDayDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!workspacesQ.data) return;
    setDayDraft((prev) => {
      const next = { ...prev };
      for (const w of workspacesQ.data!) {
        if (next[w.id] === undefined) next[w.id] = w.invite_cap_reopen_at ?? "";
      }
      return next;
    });
  }, [workspacesQ.data]);
  const dayValue = (raw: string | undefined): string | null =>
    (raw ?? "").trim() || null;
  /** Nghĩa in cạnh mỗi chỗ thay động: ưu tiên bản dịch, thiếu thì lấy câu backend
   *  gửi kèm (`t` trả về chính khoá khi không có bản dịch). */
  const tokenHint = (ph: { token: string; hint: string }): string => {
    const key = TOKEN_HINT_KEY[ph.token];
    if (!key) return ph.hint;
    const text = t(key);
    return text === key ? ph.hint : text;
  };

  // ── CÂU THÔNG BÁO dùng chung ──
  const [msgDraft, setMsgDraft] = useState<string | null>(null);
  useEffect(() => {
    if (!settingsQ.data) return;
    setMsgDraft((prev) =>
      prev === null ? (settingsQ.data!.cap_message ?? settingsQ.data!.default_message) : prev,
    );
  }, [settingsQ.data]);
  /** Gõ đúng bằng câu mặc định cũng coi như "không sửa" — khỏi lưu thừa một dòng. */
  const msgSaved =
    settingsQ.data?.cap_message ?? settingsQ.data?.default_message ?? "";
  const msgDirty = msgDraft !== null && msgDraft.trim() !== msgSaved.trim();

  const dirtyCaps = useMemo(
    () =>
      workspaces.filter((w) => {
        const capChanged =
          capDraft[w.id] !== undefined &&
          capValue(capDraft[w.id]) !== (w.invite_member_cap ?? null);
        const dayChanged =
          dayDraft[w.id] !== undefined &&
          dayValue(dayDraft[w.id]) !== (w.invite_cap_reopen_at ?? null);
        return capChanged || dayChanged;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaces, capDraft, dayDraft],
  );
  /** Số thành viên đang chiếm chỗ — cùng nguồn với dải suất trang Mời, để người đặt
   *  trần nhìn thấy đúng con số mà trần sẽ đem ra so. */
  const { seatMap } = useSeatMap();

  // Áp dụng hàng loạt chỉ chạm những dòng ĐANG HIỆN (đã lọc theo ô tìm kiếm), để
  // gõ vài ký tự là khoanh được đúng nhóm cần đổi thay vì cả danh sách.
  const q = query.trim().toLowerCase();
  const shownUsers = useMemo(
    () =>
      q
        ? subAdmins.filter(
            (u) =>
              u.email.toLowerCase().includes(q) ||
              (u.username ?? "").toLowerCase().includes(q),
          )
        : subAdmins,
    [subAdmins, q],
  );

  // Nháp theo user_id (khởi tạo từ server, chỉ điền dòng chưa sửa).
  const [draft, setDraft] = useState<Record<string, Draft>>({});
  useEffect(() => {
    if (!configQ.data) return;
    setDraft((prev) => {
      const next = { ...prev };
      for (const u of configQ.data!) {
        if (!next[u.user_id]) {
          next[u.user_id] = {
            all: u.all_workspaces,
            ids: new Set(u.workspace_ids),
          };
        }
      }
      return next;
    });
  }, [configQ.data]);

  function draftOf(u: InviteConfigUser): Draft {
    return draft[u.user_id] ?? { all: u.all_workspaces, ids: new Set(u.workspace_ids) };
  }
  function isDirty(u: InviteConfigUser): boolean {
    const d = draft[u.user_id];
    if (!d) return false;
    if (d.all !== u.all_workspaces) return true;
    if (d.all) return false; // Toàn bộ: không quan tâm danh sách ws
    const server = new Set(u.workspace_ids);
    if (d.ids.size !== server.size) return true;
    for (const id of d.ids) if (!server.has(id)) return true;
    return false;
  }
  /** Chỉ định mà không tick ws nào → TẠM NGƯNG add email mới (lưu được, không phải lỗi). */
  function isPaused(u: InviteConfigUser): boolean {
    const d = draftOf(u);
    return !d.all && d.ids.size === 0;
  }

  const dirtyUsers = useMemo(
    () => subAdmins.filter(isDirty),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [subAdmins, draft],
  );
  const pausedCount = dirtyUsers.filter(isPaused).length;

  const save = useMutation({
    mutationFn: async ({
      users,
      caps,
      message,
    }: {
      users: InviteConfigUser[];
      caps: Workspace[];
      message: string | null;
    }) => {
      const results = await Promise.allSettled(
        users.map((u) => {
          const d = draftOf(u);
          return api(`/api/v1/invite-config/users/${u.user_id}`, {
            method: "PUT",
            body: JSON.stringify({
              all_workspaces: d.all,
              workspace_ids: [...d.ids],
            }),
          });
        }),
      );
      const saved = users
        .filter((_, i) => results[i].status === "fulfilled")
        .map((u) => {
          const d = draftOf(u);
          return { ...u, all_workspaces: d.all, workspace_ids: [...d.ids] };
        });
      // Trần thành viên đi đường riêng (PATCH workspace) nhưng CHUNG một nút Lưu:
      // hai thứ nằm cùng modal, bắt bấm hai lần là kiểu gì cũng có lần quên.
      const capResults = await Promise.allSettled(
        caps.map((w) =>
          api(`/api/v1/workspaces/${w.id}`, {
            method: "PATCH",
            body: JSON.stringify({
              invite_member_cap: capValue(capDraft[w.id]),
              invite_cap_reopen_at: dayValue(dayDraft[w.id]),
            }),
          }),
        ),
      );
      const capsOk = capResults.filter((r) => r.status === "fulfilled").length;
      // Câu chữ đi đường riêng (settings toàn hệ thống), vẫn chung nút Lưu.
      let msgOk = false;
      let msgFailed = 0;
      if (message !== null) {
        try {
          await api("/api/v1/admin/invite-settings", {
            method: "PUT",
            body: JSON.stringify({ cap_message: message }),
          });
          msgOk = true;
        } catch {
          msgFailed = 1;
        }
      }
      return {
        saved,
        capsOk,
        msgOk,
        failed:
          results.length - saved.length + (capResults.length - capsOk) + msgFailed,
      };
    },
    onSuccess: ({ saved, capsOk, msgOk, failed }) => {
      // Ghi ngay giá trị vừa lưu vào cache để dấu "chưa lưu" tắt liền, không
      // phải chờ refetch (giữ nguyên nháp nên dòng không nháy về giá trị cũ).
      qc.setQueryData<InviteConfigUser[]>(["invite-config"], (old) =>
        old?.map((u) => saved.find((s) => s.user_id === u.user_id) ?? u),
      );
      if (saved.length) toast.success(t("inviteConfig.savedCount", { n: saved.length }));
      if (capsOk) toast.success(t("inviteConfig.capSavedCount", { n: capsOk }));
      if (msgOk) toast.success(t("inviteConfig.capMsgSaved"));
      if (failed) toast.error(t("inviteConfig.saveErrorCount", { n: failed }));
      qc.invalidateQueries({ queryKey: ["invite-config"] });
      qc.invalidateQueries({ queryKey: ["workspaces"] });
      qc.invalidateQueries({ queryKey: ["invite-settings"] });
      // Trang Mời đọc trạng thái chạm trần từ nguồn suất → bắt nó tươi ngay.
      invalidateWorkspaceSeats(qc);
    },
    onError: () => toast.error(t("inviteConfig.saveError")),
  });

  function setMode(userId: string, all: boolean) {
    setDraft((d) => ({ ...d, [userId]: { all, ids: d[userId]?.ids ?? new Set() } }));
  }
  function toggleWs(u: InviteConfigUser, wsId: string) {
    setDraft((d) => {
      const cur = d[u.user_id] ?? draftOf(u);
      const ids = new Set(cur.ids);
      if (ids.has(wsId)) ids.delete(wsId);
      else ids.add(wsId);
      return { ...d, [u.user_id]: { all: false, ids } };
    });
  }
  function setAllWs(u: InviteConfigUser, on: boolean) {
    setDraft((d) => ({
      ...d,
      [u.user_id]: { all: false, ids: on ? new Set(workspaces.map((w) => w.id)) : new Set() },
    }));
  }
  function revert() {
    setDraft({});
    setCapDraft({});
    setDayDraft({});
    setMsgDraft(msgSaved);
  }
  /** Tổng số thay đổi chưa lưu — thanh dưới và cửa hỏi khi đóng đều đếm theo đây. */
  const dirtyTotal = dirtyUsers.length + dirtyCaps.length + (msgDirty ? 1 : 0);

  /** Đặt cùng một cấu hình cho mọi dòng đang hiện (mới là nháp, bấm Lưu mới ăn).
   * `make` nhận nháp hiện tại của dòng để giữ lại phần không đụng tới (ví dụ chuyển
   * sang "Toàn bộ" vẫn nhớ danh sách đã tick, bấm nhầm còn quay lại được). */
  function applyToShown(make: (cur: Draft) => Draft) {
    if (shownUsers.length === 0) return;
    setDraft((d) => {
      const next = { ...d };
      for (const u of shownUsers) {
        const v = make(d[u.user_id] ?? draftOf(u));
        next[u.user_id] = { all: v.all, ids: new Set(v.ids) };
      }
      return next;
    });
    toast.success(t("inviteConfig.bulkApplied", { n: shownUsers.length }));
  }
  /** Nhân cấu hình của 1 dòng sang mọi dòng đang hiện. */
  function applyRowToAll(u: InviteConfigUser) {
    const src = draftOf(u);
    applyToShown(() => src);
  }

  async function requestClose() {
    if (dirtyTotal > 0) {
      const ok = await confirm(
        t("inviteConfig.discardConfirm", { n: dirtyTotal }),
        {
          okText: t("inviteConfig.discardOk"),
          danger: true,
        },
      );
      if (!ok) return;
    }
    onClose();
  }

  // Esc đóng modal (vẫn qua cửa hỏi bỏ thay đổi).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        void requestClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirtyTotal]);

  const loading = configQ.isLoading || workspacesQ.isLoading || settingsQ.isLoading;

  return (
    <div className="iwc-backdrop" onClick={() => void requestClose()}>
      <div
        className="surface-card iwc-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t("inviteConfig.title")}
      >
        <div className="iwc-head">
          <div style={{ minWidth: 0 }}>
            <div className="table-title">{t("inviteConfig.title")}</div>
            <div className="table-meta" style={{ marginTop: 2 }}>
              {t("inviteConfig.subtitle")}
            </div>
          </div>
          <button onClick={() => void requestClose()} className="btn btn-ghost btn-sm">
            {t("common.close")}
          </button>
        </div>

        {!loading && subAdmins.length >= SEARCH_MIN_USERS && (
          <div className="iwc-toolbar">
            <input
              className="search-input iwc-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("inviteConfig.searchPlaceholder")}
            />
            <span className="iwc-count">
              {t("inviteConfig.userCount", { n: shownUsers.length })}
            </span>
          </div>
        )}

        {!loading && shownUsers.length > 1 && (
          <div className="iwc-bulkbar">
            <span className="iwc-bulkbar-label">
              {t("inviteConfig.bulkLabel", { n: shownUsers.length })}
            </span>
            <button
              type="button"
              className="iwc-link"
              onClick={() => applyToShown((cur) => ({ all: true, ids: cur.ids }))}
            >
              {t("inviteConfig.bulkAll")}
            </button>
            <button
              type="button"
              className="iwc-link"
              onClick={() =>
                applyToShown(() => ({
                  all: false,
                  ids: new Set(workspaces.map((w) => w.id)),
                }))
              }
              disabled={workspaces.length === 0}
            >
              {t("inviteConfig.bulkPickAll")}
            </button>
            <button
              type="button"
              className="iwc-link"
              onClick={() => applyToShown(() => ({ all: false, ids: new Set() }))}
            >
              {t("inviteConfig.bulkPause")}
            </button>
          </div>
        )}

        <div className="iwc-body">
          {/* TRẦN THÀNH VIÊN — theo KHÔNG GIAN, khác hẳn phần cấu hình đích bên dưới
              (theo người). Đặt trên cùng vì đây là cái chặn cứng: đọc xong ai được
              mời vào đâu rồi mới thấy "à không gian đó đang ngưng" là đọc ngược. */}
          {!loading && workspaces.length > 0 && (
            <div className="iwc-caps">
              <div className="iwc-sect-title">{t("inviteConfig.capTitle")}</div>
              <div className="iwc-sect-hint">{t("inviteConfig.capHint")}</div>
              <div className="iwc-cap-row iwc-cap-head">
                <span className="iwc-cap-name" />
                <span className="iwc-cap-col cap">{t("inviteConfig.capColCap")}</span>
                <span className="iwc-cap-col day">{t("inviteConfig.capColDay")}</span>
              </div>
              {workspaces.map((w) => {
                const raw = capDraft[w.id] ?? "";
                const used = seatMap.get(w.id)?.seat_used;
                const cap = capValue(raw);
                const dirty = cap !== (w.invite_member_cap ?? null);
                const reached = cap !== null && used !== undefined && used >= cap;
                return (
                  <div key={w.id} className={`iwc-cap-row${dirty ? " dirty" : ""}`}>
                    <span className="iwc-cap-name" title={w.name}>
                      {w.name}
                      {dirty && <span className="iwc-dot" title={t("inviteConfig.edited")} />}
                    </span>
                    <span className={`iwc-cap-used${reached ? " over" : ""}`}>
                      {used === undefined
                        ? "—"
                        : t("inviteConfig.capUsed", { n: used })}
                    </span>
                    <input
                      className="form-input iwc-cap-input"
                      type="number"
                      min={0}
                      max={SEAT_TOTAL_MAX}
                      inputMode="numeric"
                      value={raw}
                      placeholder={t("inviteConfig.capOff")}
                      onChange={(e) =>
                        setCapDraft((d) => ({ ...d, [w.id]: e.target.value }))
                      }
                    />
                    {/* Ngày mở lại chỉ để ghép vào chỗ {ngay} của câu thông báo —
                        KHÔNG có gì tự gỡ trần khi tới ngày (xem models.py). */}
                    <input
                      className="form-input iwc-cap-day"
                      type="date"
                      value={dayDraft[w.id] ?? ""}
                      title={t("inviteConfig.capDayTitle")}
                      onChange={(e) =>
                        setDayDraft((d) => ({ ...d, [w.id]: e.target.value }))
                      }
                    />
                  </div>
                );
              })}

              {/* CÂU THÔNG BÁO dùng chung mọi không gian. Đặt DƯỚI danh sách vì đây
                  là thứ sửa một lần rồi thôi, còn số trần thì đụng thường xuyên. */}
              <div className="iwc-cap-msg">
                <div className="iwc-sect-title">{t("inviteConfig.capMsgTitle")}</div>
                <textarea
                  className="form-input iwc-cap-msg-input"
                  rows={3}
                  value={msgDraft ?? ""}
                  onChange={(e) => setMsgDraft(e.target.value)}
                />
                <div className="iwc-cap-msg-foot">
                  <div className="iwc-sect-hint">
                    {t("inviteConfig.capMsgHint")}
                    {(settingsQ.data?.placeholders ?? []).map((ph) => (
                      <div key={ph.token} className="iwc-token-line">
                        <span className="iwc-token">{ph.token}</span>
                        {tokenHint(ph)}
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="iwc-link"
                    disabled={
                      !settingsQ.data ||
                      (msgDraft ?? "").trim() ===
                        settingsQ.data.default_message.trim()
                    }
                    onClick={() =>
                      setMsgDraft(settingsQ.data?.default_message ?? "")
                    }
                  >
                    {t("inviteConfig.capMsgReset")}
                  </button>
                </div>
              </div>
            </div>
          )}
          {loading ? (
            <div className="cell-muted" style={{ padding: 16 }}>
              {t("common.loading")}
            </div>
          ) : subAdmins.length === 0 ? (
            <div className="cell-muted" style={{ padding: 16 }}>
              {t("assign.noSubAdmins")}
            </div>
          ) : shownUsers.length === 0 ? (
            <div className="cell-muted" style={{ padding: 16 }}>
              {t("inviteConfig.noMatch")}
            </div>
          ) : (
            shownUsers.map((u) => {
              const d = draftOf(u);
              const dirty = isDirty(u);
              const paused = isPaused(u);
              return (
                <div
                  key={u.user_id}
                  className={`iwc-row${dirty ? " dirty" : ""}${u.is_active ? "" : " off"}`}
                >
                  <div className="iwc-row-top">
                    <span className="iwc-email" title={u.email}>
                      {u.email}
                      {!u.is_active && (
                        <span className="iwc-tag">{t("users.disabled")}</span>
                      )}
                      {dirty && <span className="iwc-dot" title={t("inviteConfig.edited")} />}
                    </span>

                    <div className="iwc-seg" role="group">
                      <button
                        type="button"
                        className={`iwc-seg-btn${d.all ? " on" : ""}`}
                        aria-pressed={d.all}
                        onClick={() => setMode(u.user_id, true)}
                      >
                        {t("inviteConfig.modeAll")}
                      </button>
                      <button
                        type="button"
                        className={`iwc-seg-btn${d.all ? "" : " on"}`}
                        aria-pressed={!d.all}
                        onClick={() => setMode(u.user_id, false)}
                      >
                        {t("inviteConfig.modeSpecific")}
                      </button>
                    </div>
                  </div>

                  {d.all ? (
                    <div className="iwc-hint">{t("inviteConfig.allHint")}</div>
                  ) : workspaces.length === 0 ? (
                    <div className="iwc-hint">{t("inviteConfig.noWorkspaces")}</div>
                  ) : (
                    <>
                      <div className="iwc-chips">
                        {workspaces.map((w) => {
                          const on = d.ids.has(w.id);
                          return (
                            <button
                              key={w.id}
                              type="button"
                              className={`iwc-chip${on ? " on" : ""}`}
                              aria-pressed={on}
                              onClick={() => toggleWs(u, w.id)}
                              title={w.name}
                            >
                              <span className="iwc-check" aria-hidden="true">
                                {on ? "✓" : "+"}
                              </span>
                              <span className="iwc-chip-name">{w.name}</span>
                            </button>
                          );
                        })}
                        {(workspaces.length >= BULK_CHIP_MIN ||
                          shownUsers.length > 1) && (
                          <span className="iwc-bulk">
                            {workspaces.length >= BULK_CHIP_MIN && (
                              <>
                                <button
                                  type="button"
                                  className="iwc-link"
                                  onClick={() => setAllWs(u, true)}
                                  disabled={d.ids.size === workspaces.length}
                                >
                                  {t("inviteConfig.selectAll")}
                                </button>
                                <button
                                  type="button"
                                  className="iwc-link"
                                  onClick={() => setAllWs(u, false)}
                                  disabled={d.ids.size === 0}
                                >
                                  {t("inviteConfig.clearAll")}
                                </button>
                              </>
                            )}
                            {shownUsers.length > 1 && (
                              <button
                                type="button"
                                className="iwc-link"
                                onClick={() => applyRowToAll(u)}
                                title={t("inviteConfig.applyAllTitle")}
                              >
                                {t("inviteConfig.applyAll")}
                              </button>
                            )}
                          </span>
                        )}
                      </div>
                      <div className={`iwc-hint${paused ? " warn" : ""}`}>
                        {paused
                          ? t("inviteConfig.emptyPick")
                          : t("inviteConfig.pickedCount", {
                              n: d.ids.size,
                              total: workspaces.length,
                            })}
                      </div>
                    </>
                  )}
                </div>
              );
            })
          )}
        </div>

        {dirtyTotal > 0 && (
          <div className="iwc-foot">
            <span className="iwc-foot-text">
              {t("inviteConfig.dirtyCount", { n: dirtyTotal })}
              {pausedCount > 0 && (
                <span className="iwc-foot-warn">
                  {" · "}
                  {t("inviteConfig.pausedCount", { n: pausedCount })}
                </span>
              )}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={revert}
              disabled={save.isPending}
            >
              {t("inviteConfig.revert")}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() =>
                save.mutate({
                  users: dirtyUsers,
                  caps: dirtyCaps,
                  message: msgDirty ? (msgDraft ?? "") : null,
                })
              }
              disabled={save.isPending}
            >
              {save.isPending
                ? t("common.saving")
                : t("inviteConfig.saveAll", { n: dirtyTotal })}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
