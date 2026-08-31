import { describe, expect, it } from "vitest";
import {
  guidePrintHtml,
  pickGuideId,
  shouldOpen,
  vnDayKey,
  type GuideState,
} from "./index";
import type { Guide, GuideContent } from "./types";

const guide = (id: string): Guide => ({ id, content: {} as Guide["content"] });
const A = guide("a");
const B = guide("b");

describe("vnDayKey", () => {
  it("cắt ngày theo giờ VN, không theo UTC", () => {
    // 23:30 UTC ngày 30 = 06:30 sáng ngày 31 ở VN.
    expect(vnDayKey(new Date("2026-08-30T23:30:00Z"))).toBe("2026-08-31");
    // 16:59 UTC ngày 30 = 23:59 ngày 30 ở VN — vẫn còn là hôm qua.
    expect(vnDayKey(new Date("2026-08-30T16:59:00Z"))).toBe("2026-08-30");
  });
});

describe("pickGuideId", () => {
  it("giữ nguyên bài đã chốt cho ngày hôm nay", () => {
    const state: GuideState = { day: "2026-08-31", guideId: "b" };
    expect(pickGuideId("2026-08-31", state, [A, B], () => 0)).toBe("b");
  });

  it("sang ngày mới thì không bốc lại bài hôm qua", () => {
    const state: GuideState = { day: "2026-08-30", guideId: "b" };
    // rand nào cũng vậy: b đã bị loại khỏi rổ.
    expect(pickGuideId("2026-08-31", state, [A, B], () => 0)).toBe("a");
    expect(pickGuideId("2026-08-31", state, [A, B], () => 0.99)).toBe("a");
  });

  it("chỉ có một bài thì vẫn hiện lại chính nó", () => {
    const state: GuideState = { day: "2026-08-30", guideId: "a" };
    expect(pickGuideId("2026-08-31", state, [A], () => 0.99)).toBe("a");
  });

  it("bài trong state đã bị gỡ khỏi danh sách → bốc bài khác", () => {
    const state: GuideState = { day: "2026-08-31", guideId: "cu" };
    expect(pickGuideId("2026-08-31", state, [A], () => 0)).toBe("a");
  });

  it("không có bài nào thì trả null", () => {
    expect(pickGuideId("2026-08-31", {}, [], () => 0)).toBeNull();
  });
});

describe("shouldOpen", () => {
  it("mở cho lượt vào web đầu tiên trong ngày", () => {
    expect(shouldOpen("2026-08-31", {}, null, [A])).toBe(true);
  });

  it("đã tick không hiện lại hôm nay → im tới hết ngày", () => {
    const state: GuideState = { mutedDay: "2026-08-31" };
    expect(shouldOpen("2026-08-31", state, null, [A])).toBe(false);
    // Sang ngày mới thì lời tắt hết hiệu lực.
    expect(shouldOpen("2026-09-01", state, null, [A])).toBe(true);
  });

  it("đã xem trong tab này (kể cả sau F5) thì không hiện lại", () => {
    expect(shouldOpen("2026-08-31", {}, "2026-08-31", [A])).toBe(false);
    // Tab mở từ hôm qua, để qua đêm → hôm nay vẫn hiện.
    expect(shouldOpen("2026-08-31", {}, "2026-08-30", [A])).toBe(true);
  });
});

describe("guidePrintHtml", () => {
  const content: GuideContent = {
    eyebrow: "Hướng dẫn",
    title: "Tên bài <có dấu ngoặc>",
    intro: "Mở **Cài đặt**",
    sections: [
      {
        heading: "Cách 1",
        steps: [
          { title: "Bước một", body: "Bấm **Use reset**", image: "/assets/a.png", caption: "A" },
          { title: "Bước hai", body: "Xong" },
        ],
      },
    ],
    notes: ["Chỉ **1 lần** mỗi tháng"],
  };
  const html = guidePrintHtml(content, {
    lang: "vi",
    notesLabel: "Lưu ý",
    baseUrl: "https://gpt.lovevn.org/dashboard",
  });

  it("đủ bước, đủ lưu ý, đánh số lại từ 01", () => {
    expect(html).toContain("Bước một");
    expect(html).toContain("Bước hai");
    expect(html).toContain(">01<");
    expect(html).toContain(">02<");
    expect(html).toContain("Chỉ <strong>1 lần</strong> mỗi tháng");
  });

  it("ảnh đổi sang URL tuyệt đối — cửa sổ in là about:blank", () => {
    expect(html).toContain('src="https://gpt.lovevn.org/assets/a.png"');
  });

  it("escape trước rồi mới dựng **đậm**, không lọt HTML thô", () => {
    expect(html).toContain("Tên bài &lt;có dấu ngoặc&gt;");
    expect(html).toContain("Mở <strong>Cài đặt</strong>");
  });
});
