import { describe, expect, it } from "vitest";
import {
  GUIDES,
  fillGuideVars,
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

describe("nội dung các bài", () => {
  const LANGS = ["vi", "zh-CN"] as const;

  it("id không trùng nhau — bài ghim theo ngày tra bằng id", () => {
    const ids = GUIDES.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(GUIDES.map((g) => [g.id, g] as const))(
    "%s: mọi ngôn ngữ cùng số phần và cùng số bước",
    (_id, guide) => {
      const shape = (c: GuideContent) => c.sections.map((s) => s.steps.length);
      // Bài vẽ theo `sections` của ĐÚNG ngôn ngữ đang xem: bản dịch thiếu một phần
      // thì người xem tiếng đó mất hẳn phần đó mà không có gì báo.
      const first = shape(guide.content[LANGS[0]]);
      for (const lang of LANGS) expect(shape(guide.content[lang])).toEqual(first);
    },
  );

  it.each(GUIDES.map((g) => [g.id, g] as const))(
    "%s: mọi ngôn ngữ đều có tiêu đề đủ ngắn cho mục lục",
    (_id, guide) => {
      for (const lang of LANGS) {
        const { title } = guide.content[lang];
        // Tiêu đề CHÍNH LÀ nhãn trong mục lục bên trái; dài quá thì một dòng mục
        // lục ăn ba bốn dòng, cột trái thành khối chữ.
        expect(title.trim()).not.toBe("");
        expect(title.length).toBeLessThanOrEqual(48);
      }
    },
  );
});

describe("fillGuideVars", () => {
  const withSlots = (): GuideContent => ({
    eyebrow: "Hướng dẫn",
    title: "Bài có chỗ trống",
    intro: "Đơn giá của bạn {donGia}",
    sections: [
      {
        steps: [
          { title: "Không cần số", body: "Câu này luôn hiện" },
          { title: "Ví dụ", body: "Trả {tien} cho 22 ngày" },
        ],
      },
      { heading: "Chỉ có số", steps: [{ title: "Giá ngày", body: "{giaNgay} mỗi ngày" }] },
      {
        heading: "Bảng",
        steps: [
          {
            title: "Hai ca mua",
            body: "Xem bảng",
            table: { head: ["Ngày mua", "Trả"], rows: [["10/8", "{tien}"]] },
          },
        ],
      },
    ],
    notes: ["Ghi chú thường", "Tính theo {donGia}"],
  });

  it("điền đủ thì giữ nguyên mọi câu", () => {
    const out = fillGuideVars(withSlots(), {
      donGia: "330.000 ₫",
      tien: "234.000 ₫",
      giaNgay: "11.000 ₫",
    });
    expect(out.intro).toBe("Đơn giá của bạn 330.000 ₫");
    expect(out.sections).toHaveLength(3);
    expect(out.sections[0].steps[1].body).toBe("Trả 234.000 ₫ cho 22 ngày");
    expect(out.sections[2].steps[0].table).toEqual({
      head: ["Ngày mua", "Trả"],
      rows: [["10/8", "234.000 ₫"]],
    });
    expect(out.notes).toEqual(["Ghi chú thường", "Tính theo 330.000 ₫"]);
  });

  it("thiếu số thì BỎ câu đó, không hiện chỗ trống cũng không hiện số sai", () => {
    const out = fillGuideVars(withSlots(), {});
    // Bước không cần số vẫn còn; bước cần số biến mất cùng cả phần rỗng theo nó —
    // kể cả bước mà chỗ trống chỉ nằm trong một Ô BẢNG.
    expect(out.sections).toHaveLength(1);
    expect(out.sections[0].steps.map((s) => s.title)).toEqual(["Không cần số"]);
    expect(out.notes).toEqual(["Ghi chú thường"]);
  });

  it("bài không có chỗ trống nào thì không đụng tới", () => {
    const plain: GuideContent = {
      eyebrow: "e",
      title: "t",
      intro: "i",
      sections: [{ steps: [{ title: "a", body: "b" }] }],
      notes: ["n"],
    };
    expect(fillGuideVars(plain, {})).toEqual(plain);
  });
});

describe("bài ngày chốt — số tiền theo đơn giá của người đọc", () => {
  const guide = GUIDES.find((g) => g.id === "cycle-billing")!;

  it.each([
    // đơn giá, giá 1 ngày, tiền 22 ngày lẻ, tiền 7 ngày lẻ + 1 tháng — làm tròn
    // LÊN bội TRĂM (`price_round_to_vnd`), chu kỳ 31 ngày (đúng ví dụ 1/8 → 1/9
    // trong bài). Bội nghìn là con số cũ: bài sẽ lệch với tổng ở bảng mời.
    [380_000, "12.300 ₫", "269.700 ₫", "465.900 ₫"],
    [330_000, "10.700 ₫", "234.200 ₫", "404.600 ₫"],
  ])("đơn giá %i ra đúng ba con số ví dụ", (fee, ngay, som, sat) => {
    const vars = guide.vars!({ feeVnd: fee });
    expect(vars.giaNgay).toBe(ngay);
    expect(vars.vdSom).toBe(som);
    expect(vars.vdSat).toBe(sat);
  });

  it("số tiền trong BẢNG cũng theo đơn giá người đọc", () => {
    const filled = fillGuideVars(guide.content.vi, guide.vars!({ feeVnd: 380_000 }));
    const rows = filled.sections
      .flatMap((s) => s.steps)
      .flatMap((step) => step.table?.rows ?? []);
    expect(rows.flat().join(" ")).toContain("269.700 ₫");
    expect(rows.flat().join(" ")).toContain("465.900 ₫");
  });

  it("chưa biết đơn giá thì bước cần số biến mất, kéo theo cả bảng", () => {
    const full = fillGuideVars(guide.content.vi, guide.vars!({ feeVnd: 380_000 }));
    const blank = fillGuideVars(guide.content.vi, guide.vars!({ feeVnd: null }));
    const steps = (c: GuideContent) => c.sections.flatMap((s) => s.steps).length;
    expect(steps(blank)).toBe(steps(full) - 1);
    // Không còn chỗ trống nào lọt ra màn hình dưới dạng "{donGia}".
    expect(JSON.stringify(blank)).not.toMatch(/\{[A-Za-z0-9_]+\}/);
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
          {
            title: "Bước hai",
            body: "Xong",
            table: { head: ["Ngày mua", "Trả"], rows: [["10/8", "**270.000 ₫**"]] },
          },
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

  it("bảng của bước ra đủ đầu cột và các ô, có cả phần in đậm", () => {
    expect(html).toContain("<th>Ngày mua</th>");
    expect(html).toContain("<td><strong>270.000 ₫</strong></td>");
  });

  it("ảnh đổi sang URL tuyệt đối — cửa sổ in là about:blank", () => {
    expect(html).toContain('src="https://gpt.lovevn.org/assets/a.png"');
  });

  it("escape trước rồi mới dựng **đậm**, không lọt HTML thô", () => {
    expect(html).toContain("Tên bài &lt;có dấu ngoặc&gt;");
    expect(html).toContain("Mở <strong>Cài đặt</strong>");
  });
});
