/**
 * Chốt luật tự đóng tab admin để không (user 2026-08-24: 30 phút).
 *
 * Hai thứ dễ hỏng nhất nằm ở đây: đóng nhầm tab đang có việc (mất tab giữa lúc
 * chạy lệnh), và KHÔNG BAO GIỜ đóng tab thứ hai vì nó dùng chung đồng hồ với
 * tab thứ nhất — đúng lỗi của bản trước.
 */
import { describe, expect, it } from "vitest";

import { decideIdleClose, IDLE_CLOSE_MS } from "./idle-close";

const NOW = 1_700_000_000_000;
const MIN = 60_000;

const tab = (tabId: number, opts: { active?: boolean; lastAccessed?: number } = {}) => ({
  tabId,
  active: opts.active ?? false,
  lastAccessed: opts.lastAccessed,
});

describe("decideIdleClose", () => {
  it("ngưỡng là 30 phút", () => {
    expect(IDLE_CLOSE_MS).toBe(30 * MIN);
  });

  it("để không quá 30 phút → đóng", () => {
    const { closeIds, nextState } = decideIdleClose(
      [tab(7)],
      { 7: NOW - 31 * MIN },
      NOW,
      { busy: false },
    );
    expect(closeIds).toEqual([7]);
    expect(nextState).toEqual({}); // đóng rồi thì không giữ mốc nữa
  });

  it("mới dùng 29 phút trước → giữ", () => {
    const { closeIds, nextState } = decideIdleClose(
      [tab(7)],
      { 7: NOW - 29 * MIN },
      NOW,
      { busy: false },
    );
    expect(closeIds).toEqual([]);
    expect(nextState).toEqual({ 7: NOW - 29 * MIN });
  });

  it("MỖI TAB MỘT ĐỒNG HỒ — tab bỏ không bị đóng, tab đang dùng thì không", () => {
    const { closeIds } = decideIdleClose(
      [tab(1), tab(2)],
      { 1: NOW - 2 * MIN, 2: NOW - 45 * MIN },
      NOW,
      { busy: false },
    );
    expect(closeIds).toEqual([2]);
  });

  it("runner đang chạy task → không đóng gì, kể cả tab đã quá hạn", () => {
    const { closeIds, nextState } = decideIdleClose(
      [tab(1), tab(2)],
      { 1: NOW - 90 * MIN, 2: NOW - 90 * MIN },
      NOW,
      { busy: true },
    );
    expect(closeIds).toEqual([]);
    expect(nextState).toEqual({ 1: NOW - 90 * MIN, 2: NOW - 90 * MIN });
  });

  it("user đang mở xem tab → coi như vừa hoạt động, không đóng", () => {
    const { closeIds, nextState } = decideIdleClose(
      [tab(3, { active: true })],
      { 3: NOW - 90 * MIN },
      NOW,
      { busy: false },
    );
    expect(closeIds).toEqual([]);
    expect(nextState).toEqual({ 3: NOW });
  });

  it("user vừa xem tab gần đây (lastAccessed mới hơn mốc của extension) → giữ", () => {
    const { closeIds } = decideIdleClose(
      [tab(3, { lastAccessed: NOW - 5 * MIN })],
      { 3: NOW - 90 * MIN },
      NOW,
      { busy: false },
    );
    expect(closeIds).toEqual([]);
  });

  it("tab lạ chưa có mốc nào → tính từ bây giờ, KHÔNG đóng ngay", () => {
    const { closeIds, nextState } = decideIdleClose([tab(9)], {}, NOW, {
      busy: false,
    });
    expect(closeIds).toEqual([]);
    expect(nextState).toEqual({ 9: NOW });
  });

  it("tab đã biến mất khỏi sổ thì mốc của nó cũng bị dọn", () => {
    const { nextState } = decideIdleClose(
      [tab(1)],
      { 1: NOW - MIN, 99: NOW - MIN },
      NOW,
      { busy: false },
    );
    expect(nextState).toEqual({ 1: NOW - MIN });
  });
});
