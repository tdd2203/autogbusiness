import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useT } from "../i18n";
import { toast } from "../components/Toast";

/**
 * Kết nối Telegram của CHÍNH tài khoản đang đăng nhập.
 *
 * Dùng chung cho hai chỗ hỏi cùng một câu "đã bấm Start chưa?":
 *   - `TelegramSettings` (Cài đặt → Telegram, và khối trên trang Thông báo)
 *   - `TelegramConnectGate` (màn bắt buộc kết nối trước khi vào trang Thông báo)
 *
 * Gom vào một hook để hai màn dùng cùng queryKey ⇒ bấm Start ở màn nào thì màn kia
 * cũng đổi trạng thái ngay, không có cảnh một bên "đã kết nối" bên kia vẫn mời kết nối.
 */

export type TelegramStatus = {
  bot_configured: boolean;
  bot_username: string | null;
  linked: boolean;
  telegram_username: string | null;
  telegram_chat_id: number | null;
  linked_at: string | null;
  notify_enabled: boolean;
  reminder_days: number[];
  reminder_hour: number;
};

type LinkOut = { deep_link: string; token: string; expires_at: string };

export function useTelegramConnect() {
  const t = useT();
  const qc = useQueryClient();
  const [deepLink, setDeepLink] = useState<string | null>(null);
  // Đã bấm "Kết nối" và đang đợi user bấm Start bên Telegram.
  const [awaiting, setAwaiting] = useState(false);

  const { data: status, isLoading } = useQuery({
    queryKey: ["telegram-status"],
    queryFn: () => api<TelegramStatus>("/api/v1/telegram/status"),
    // Start được bấm ở APP KHÁC (Telegram desktop/điện thoại) nên tab này có thể
    // không mất focus ⇒ refetchOnWindowFocus không đủ. Hỏi lại đều để trạng thái
    // "Đã kết nối" tự hiện, người dùng khỏi phải bấm "Làm mới" mà không biết.
    refetchInterval: awaiting ? 3000 : false,
  });

  // Kết nối xong: báo rõ thành công và dọn hộp link (link dùng-một-lần, đã xong việc).
  useEffect(() => {
    if (!awaiting || !status?.linked) return;
    setAwaiting(false);
    setDeepLink(null);
    toast.success(t("telegram.connectedToast"));
  }, [awaiting, status?.linked, t]);

  // Bỏ cuộc sau khi mã hết hạn (15 phút) — không hỏi server mãi khi user bỏ dở.
  useEffect(() => {
    if (!awaiting) return;
    const id = setTimeout(() => setAwaiting(false), 15 * 60 * 1000);
    return () => clearTimeout(id);
  }, [awaiting]);

  const link = useMutation({
    mutationFn: () => api<LinkOut>("/api/v1/telegram/link", { method: "POST" }),
    onSuccess: (res) => {
      setDeepLink(res.deep_link);
      setAwaiting(true);
      // Mở luôn Telegram: user chỉ còn 1 thao tác là bấm Start.
      window.open(res.deep_link, "_blank", "noopener");
    },
    onError: (e) =>
      toast.error(e instanceof ApiError ? String(e.detail) : t("telegram.linkError")),
  });

  return {
    status,
    /** Chưa có câu trả lời từ server — đừng vội kết luận "chưa kết nối". */
    isLoading,
    deepLink,
    setDeepLink,
    awaiting,
    setAwaiting,
    link,
    refresh: () => qc.invalidateQueries({ queryKey: ["telegram-status"] }),
  };
}
