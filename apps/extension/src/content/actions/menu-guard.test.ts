import { describe, expect, it } from "vitest";
import { TEXT_FALLBACKS } from "../i18n-ui";
import {
  isDataMenuItemText,
  isDataTextOfKind,
  pickDataMenuItemIndex,
  pickRemoveMenuItemIndex,
  sanitizeRemoveLabels,
} from "./menu-guard";

const FALLBACK = TEXT_FALLBACKS.removeMenuItem;

// Menu "..." của member ĐÃ THAM GIA sau update ChatGPT 2026-08 (theo ảnh user).
const MENU_VI = ["Xuất dữ liệu", "Xoá dữ liệu", "Loại bỏ thành viên"];
const MENU_EN = ["Export data", "Delete data", "Remove member"];
const MENU_ZH = ["导出数据", "删除数据", "移除成员"];

describe("isDataMenuItemText", () => {
  it.each([
    "Xuất dữ liệu",
    "Xoá dữ liệu",
    "Xóa dữ liệu",
    "Export data",
    "Delete data",
    "导出数据",
    "删除数据",
  ])("chặn item dữ liệu: %s", (t) => {
    expect(isDataMenuItemText(t)).toBe(true);
  });

  it.each(["Loại bỏ thành viên", "Remove member", "移除成员", "Thay đổi loại giấy phép"])(
    "KHÔNG chặn item hợp lệ: %s",
    (t) => {
      expect(isDataMenuItemText(t)).toBe(false);
    },
  );
});

describe("pickRemoveMenuItemIndex — menu 3 item (UI 2026-08)", () => {
  it("vi: chọn 'Loại bỏ thành viên', không đụng 'Xoá dữ liệu'", () => {
    expect(pickRemoveMenuItemIndex(MENU_VI, FALLBACK)).toBe(2);
  });

  it("en: chọn 'Remove member'", () => {
    expect(pickRemoveMenuItemIndex(MENU_EN, FALLBACK)).toBe(2);
  });

  it("zh: chọn '移除成员'", () => {
    expect(pickRemoveMenuItemIndex(MENU_ZH, FALLBACK)).toBe(2);
  });

  it("ChatGPT đổi nhãn item xoá → trả -1 (FAILED) chứ KHÔNG rơi vào 'Xoá dữ liệu'", () => {
    // "Gỡ thành viên" chưa có trong fallback → không nhãn nào khớp item hợp lệ;
    // nhãn lỏng "Xoá"/"Delete"/"删除" chỉ còn khớp item dữ liệu → phải bị chặn.
    const renamed = ["Xuất dữ liệu", "Xoá dữ liệu", "Gỡ thành viên"];
    expect(pickRemoveMenuItemIndex(renamed, FALLBACK)).toBe(-1);
  });

  it("khớp CHÍNH XÁC được ưu tiên hơn substring dù nhãn đứng sau", () => {
    // "Remove" (nhãn thứ 3) khớp substring 'Remove from other workspace' ở index 0,
    // nhưng 'Remove member' khớp CHÍNH XÁC ở index 1 → phải chọn index 1.
    const menu = ["Remove from other workspace", "Remove member"];
    expect(pickRemoveMenuItemIndex(menu, ["Remove", "Remove member"])).toBe(1);
  });

  it("menu rỗng / không có item nào khớp → -1", () => {
    expect(pickRemoveMenuItemIndex([], FALLBACK)).toBe(-1);
    expect(pickRemoveMenuItemIndex(["Xuất dữ liệu"], FALLBACK)).toBe(-1);
  });
});

describe("pickDataMenuItemIndex — 2 action Xuất/Xoá dữ liệu", () => {
  it.each([
    ["vi", MENU_VI],
    ["en", MENU_EN],
    ["zh", MENU_ZH],
  ])("%s: export → mục đầu, delete → mục thứ hai", (_locale, menu) => {
    expect(pickDataMenuItemIndex(menu, "export")).toBe(0);
    expect(pickDataMenuItemIndex(menu, "delete")).toBe(1);
  });

  it("KHÔNG bao giờ trả về mục 'Loại bỏ thành viên'", () => {
    for (const menu of [MENU_VI, MENU_EN, MENU_ZH]) {
      expect(pickDataMenuItemIndex(menu, "export")).not.toBe(2);
      expect(pickDataMenuItemIndex(menu, "delete")).not.toBe(2);
    }
  });

  it("menu chỉ có 'Loại bỏ thành viên' (UI cũ) → -1 cho cả 2 kind", () => {
    expect(pickDataMenuItemIndex(["Loại bỏ thành viên"], "export")).toBe(-1);
    expect(pickDataMenuItemIndex(["Loại bỏ thành viên"], "delete")).toBe(-1);
  });

  it("chỉ có mục xuất → xin delete vẫn trả -1 (không rơi sang mục kia)", () => {
    expect(pickDataMenuItemIndex(["Xuất dữ liệu"], "delete")).toBe(-1);
    expect(pickDataMenuItemIndex(["Xoá dữ liệu"], "export")).toBe(-1);
  });
});

describe("isDataTextOfKind — chốt tiêu đề dialog", () => {
  it("khớp đúng loại, không khớp loại kia", () => {
    expect(isDataTextOfKind("Xoá dữ liệu", "delete")).toBe(true);
    expect(isDataTextOfKind("Xoá dữ liệu", "export")).toBe(false);
    expect(isDataTextOfKind("Export data", "export")).toBe(true);
    expect(isDataTextOfKind("Loại bỏ thành viên", "delete")).toBe(false);
  });
});

describe("sanitizeRemoveLabels — label DB bị harvest nhầm", () => {
  it("loại nhãn 'Xoá dữ liệu' khỏi danh sách dò, giữ nhãn hợp lệ", () => {
    expect(sanitizeRemoveLabels(["Xoá dữ liệu", "Loại bỏ thành viên"])).toEqual({
      safe: ["Loại bỏ thành viên"],
      blocked: ["Xoá dữ liệu"],
    });
  });

  it("label DB độc hại + menu mới → vẫn chọn đúng item xoá member", () => {
    const { safe } = sanitizeRemoveLabels(["Xoá dữ liệu"]);
    expect(pickRemoveMenuItemIndex(MENU_VI, [...safe, ...FALLBACK])).toBe(2);
  });
});
