import { describe, expect, it } from "vitest";
import {
  GUIDES,
  GUIDE_LANGS,
  PRINT_NOTES_LABEL,
  fillGuideVars,
  guidePrintHtml,
  pickGuideId,
  readerFeeVnd,
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
  const LANGS = GUIDE_LANGS;

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

describe("bài hướng dẫn đủ ba ngôn ngữ", () => {
  it("mọi bài đều có tiếng Việt, tiếng Trung và tiếng Anh", () => {
    expect(GUIDE_LANGS).toEqual(["vi", "zh-CN", "en"]);
    for (const guide of GUIDES) {
      for (const lang of GUIDE_LANGS) {
        const c = guide.content[lang];
        expect(c?.title?.trim(), `${guide.id}/${lang}`).toBeTruthy();
        expect(c.sections.flatMap((sec) => sec.steps).length).toBeGreaterThan(0);
      }
    }
  });

  it("bản in có nhãn Lưu ý theo ĐÚNG ngôn ngữ bài, không lẫn tiếng Việt", () => {
    // Bản tiếng Anh mà mục cuối đề "Lưu ý" là bản in nửa nạc nửa mỡ.
    for (const lang of GUIDE_LANGS) expect(PRINT_NOTES_LABEL[lang]).toBeTruthy();
    const guide = GUIDES.find((g) => g.id === "business-vs-plus")!;
    const html = guidePrintHtml(guide.content.en, {
      lang: "en",
      notesLabel: PRINT_NOTES_LABEL.en,
    });
    expect(html).toContain('lang="en"');
    expect(html).toContain("Notes");
    expect(html).not.toContain("Lưu ý");
  });
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

describe("bài ngày thanh toán — số tiền theo đơn giá của người đọc", () => {
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

describe("bài sáu gói ChatGPT", () => {
  const guide = GUIDES.find((g) => g.id === "business-vs-plus")!;
  const steps = (c: GuideContent) => c.sections.flatMap((s) => s.steps);

  it("bài chỉ có đúng một bảng, không còn số nào theo đơn giá người đọc", () => {
    // Hết chỗ trống `{tên}` thì cũng không được còn `vars` lẫn ô gõ đơn giá —
    // ô nhập ở bước không dùng số chỉ tổ đứng đó vô duyên.
    expect(guide.vars).toBeUndefined();
    for (const lang of GUIDE_LANGS) {
      expect(steps(guide.content[lang]).length).toBe(1);
      expect(steps(guide.content[lang])[0].feeInput).toBeUndefined();
      expect(JSON.stringify(guide.content[lang])).not.toMatch(/\{[A-Za-z0-9_]+\}/);
    }
  });

  it("bảng 6 gói: cột được khuyên là Suất Business, cột đối chiếu là Plus, ở mọi ngôn ngữ", () => {
    for (const lang of GUIDE_LANGS) {
      const big = steps(guide.content[lang])[0];
      expect(big.table!.head.length).toBe(7);
      const hi = big.table!.highlight!;
      expect(big.table!.head[hi]).toMatch(/Business/);
      // Plus là gói khách hay đem ra so, phải nổi cùng Business nhưng bằng màu
      // khác — hai cột không được trùng chỉ số, kẻo một lớp đè mất lớp kia.
      const base = big.table!.baseline!;
      expect(big.table!.head[base]).toBe("Plus");
      expect(base).not.toBe(hi);
      // Nhãn "Nên chọn" phải có ở mọi ngôn ngữ — thiếu là bản tiếng Anh in ra
      // cột Business trơ khung không chữ.
      expect(big.table!.highlightLabel).toBeTruthy();
      // Mọi hàng đủ 7 ô — thiếu một ô là cột gói lệch sang trái, đọc sai gói.
      for (const row of big.table!.rows) expect(row.length).toBe(7);
    }
  });

  it("6 Pro là một nấc của thanh suy luận, và Plus thì nấc đó bị KHOÁ", () => {
    const rows = steps(guide.content.vi)[0].table!.rows;
    // Nấc suy luận: Pro, suất Business và Enterprise chạy hết thanh tới 6 Pro.
    const nac = rows.find((r) => r[0].includes("Nấc suy luận"))!;
    for (const i of [4, 5, 6]) expect(nac[i]).toContain("6 Pro");
    expect(nac[3]).not.toContain("6 Pro");
    // Dòng hạn mức chỉ nói số tin, không lặp lại chuyện có hay không.
    const han = rows.find((r) => r[0].includes("Hạn mức 6 Pro"))!;
    expect(han[3]).toBe("Khoá");
    expect(han[4]).toContain("tin/tuần");
    expect(han[5]).toContain("15 tin/tháng");
  });

  it("Codex & Work: Plus và Business như nhau nên KHÔNG in đậm cột Business", () => {
    for (const lang of GUIDE_LANGS) {
      const row = steps(guide.content[lang])[0].table!.rows.find((r) =>
        r[0].includes("Codex"),
      )!;
      expect(row[5]).toBe(row[3]);
      expect(row[5]).not.toContain("**");
    }
  });

  it("lưu ý Work/Codex có ở mọi ngôn ngữ và nói rõ suất Business bằng Plus", () => {
    // Khách dùng Codex nặng phải được biết trước chỗ này — thiếu bản dịch nào là
    // khách đọc ngôn ngữ đó mua nhầm.
    for (const lang of GUIDE_LANGS) {
      const notes = guide.content[lang].notes!;
      expect(notes.length).toBe(3);
      expect(notes[1]).toMatch(/Codex/);
      expect(notes[1]).toMatch(/Plus/);
      expect(notes[1]).toMatch(/Business/);
      // Dòng riêng cho suất Business: số ước tính của Standard theo bảng OpenAI,
      // Premium khác chỗ nào, và hết hạn mức thì đi đường nào.
      expect(notes[2]).toMatch(/5–45/);
      expect(notes[2]).toMatch(/250–2[.,]000/);
      expect(notes[2]).toMatch(/Premium/);
      expect(notes[2]).toMatch(/credits/);
    }
  });

  it("bản in đánh dấu bảng so sánh rộng, cột được khuyên và cột đối chiếu", () => {
    const html = guidePrintHtml(guide.content.vi, { lang: "vi", notesLabel: "Lưu ý" });
    expect(html).toContain('<table class="step-table compare wide">');
    expect(html).toContain('<th class="is-hi"><span class="badge">Nên chọn</span>Suất Business</th>');
    expect(html).toContain('<th class="is-base">Plus</th>');
    expect(html).toContain(".step-table.compare .is-hi { background");
    expect(html).toContain(".step-table.compare .is-base { background");
    // Hai cột phải khác màu nền — cùng màu thì khách tưởng cả hai đều được khuyên.
    const bg = (cls: string) => html.match(new RegExp(`\\.step-table\\.compare \\.${cls} \\{ background: (#[0-9a-f]+)`))![1];
    expect(bg("is-hi")).not.toBe(bg("is-base"));
  });
});

describe("readerFeeVnd", () => {
  it("chưa gõ gì thì lấy đơn giá thật của người đọc", () => {
    expect(readerFeeVnd(null, 330_000)).toBe(330_000);
  });

  it("gõ giá khác thì bài tính theo giá vừa gõ", () => {
    expect(readerFeeVnd("450000", 330_000)).toBe(450_000);
  });

  it("gõ dở (rỗng, 0) thì lùi về giá thật, không làm mất bước ví dụ", () => {
    // Trả null ở đây là `fillGuideVars` bỏ cả bước, ô nhập biến mất theo — người
    // đang xoá để gõ lại hết đường lùi.
    expect(readerFeeVnd("", 330_000)).toBe(330_000);
    expect(readerFeeVnd("0", 330_000)).toBe(330_000);
  });

  it("chưa biết giá thật mà cũng chưa gõ thì vẫn là chưa biết", () => {
    expect(readerFeeVnd(null, null)).toBeNull();
  });

  it("số trong bài đổi theo đúng giá vừa gõ", () => {
    const guide = GUIDES.find((g) => g.id === "cycle-billing")!;
    const vars = guide.vars!({ feeVnd: readerFeeVnd("380000", 330_000) });
    expect(vars.donGia).toBe("380.000 ₫");
    expect(vars.vdSom).toBe("269.700 ₫");
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
