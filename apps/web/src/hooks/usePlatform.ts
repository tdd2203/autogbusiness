/**
 * Nhánh nền tảng của trang đang mở.
 *
 * Nguồn thật là ĐƯỜNG DẪN: mọi trang của Canva nằm dưới `/canva/...`, còn lại là
 * ChatGPT. Không giữ trạng thái nhớ nhánh ở đâu cả — nhớ thì có ngày sidebar nói
 * Canva mà bảng bên cạnh đang là dữ liệu ChatGPT.
 *
 * Trang dùng chung hai nhánh (Tổng quan, Email đã thêm, Gia hạn, Thông báo, Nhật ký)
 * đọc hook này để gắn `?platform=` vào lời gọi API và vào queryKey — hai nhánh vì thế
 * có cache riêng, không đè số của nhau.
 */
import { useLocation } from "react-router-dom";
import type { Platform } from "../types";

export function usePlatform(): Platform {
  const { pathname } = useLocation();
  return pathname.startsWith("/canva") ? "canva" : "gpt";
}

/**
 * Gốc đường dẫn danh sách không gian của một nhánh.
 *
 * Hai nhánh dùng CHUNG trang (Workspaces / WorkspaceLayout / Members) nên mọi link
 * nội bộ phải dựng từ đây, đừng viết cứng "/workspaces" — viết cứng thì bấm tên team
 * trong nhánh Canva lại nhảy sang workspace ChatGPT.
 */
export function workspaceBasePath(platform: Platform): string {
  return platform === "canva" ? "/canva/teams" : "/workspaces";
}
