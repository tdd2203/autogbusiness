/**
 * CHỐT ĐẮT NHẤT của luồng mua: bấm ĐÚNG bộ đếm.
 *
 * Từ 26/8/2026 hộp "Quản lý suất" có MỘT bộ đếm cho MỖI loại suất (ảnh user):
 *
 *   Tiêu chuẩn   260.500 đ/tháng   [−] 152 [+]
 *   Cao cấp    3.245.000 đ/tháng   [−]   0 [+]
 *
 * Suất Cao cấp đắt hơn 12 LẦN. Bản trước lấy "cặp nút hợp lệ đầu tiên trong
 * hộp" — đúng hàng hay không phụ thuộc thứ tự DOM, không có gì bảo đảm. Test
 * này chốt: ghim được hàng Tiêu chuẩn thì bấm hàng đó, ghim không được thì
 * KHÔNG bấm gì cả.
 *
 * Repo không có jsdom → dựng cây DOM giả tối thiểu, chỉ đủ những gì
 * `findSeatStepper` đụng tới (children/parentElement/textContent/contains/
 * closest/querySelectorAll("*"|"button"|"input")/getBoundingClientRect).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { findSeatStepper } from "./find-seat-stepper";

type Rect = { left: number; top: number; width: number; height: number; right: number; bottom: number };

class E {
  parent: E | null = null;
  kids: E[] = [];
  attrs: Record<string, string> = {};
  rect: Rect = { left: 0, top: 0, width: 20, height: 20, right: 20, bottom: 20 };
  constructor(
    public tag: string,
    public ownText = "",
  ) {}

  add(...kids: E[]): this {
    for (const k of kids) {
      k.parent = this;
      this.kids.push(k);
    }
    return this;
  }
  at(left: number, top: number): this {
    this.rect = { left, top, width: 20, height: 20, right: left + 20, bottom: top + 20 };
    return this;
  }

  /** DOM thật có `tagName` viết hoa — đường đọc `<input>` dựa vào nó. */
  get tagName(): string {
    return this.tag.toUpperCase();
  }
  /** Giá trị ô `<input>`; các thẻ khác không dùng tới. */
  value = "";
  get children(): E[] {
    return this.kids;
  }
  get parentElement(): E | null {
    return this.parent;
  }
  get isConnected(): boolean {
    return true;
  }
  get offsetParent(): E | null {
    return this.parent;
  }
  get textContent(): string {
    return this.kids.length === 0 ? this.ownText : this.kids.map((k) => k.textContent).join(" ");
  }
  hasAttribute(n: string): boolean {
    return n in this.attrs;
  }
  getAttribute(n: string): string | null {
    return this.attrs[n] ?? null;
  }
  getBoundingClientRect(): Rect {
    return this.rect;
  }
  matches(sel: string): boolean {
    if (sel === "*") return true;
    return sel.split(",").some((s) => s.trim() === this.tag);
  }
  descendants(): E[] {
    return this.kids.flatMap((k) => [k, ...k.descendants()]);
  }
  querySelectorAll(sel: string): E[] {
    return this.descendants().filter((d) => d.matches(sel));
  }
  closest(sel: string): E | null {
    let n: E | null = this;
    while (n) {
      if (n.matches(sel)) return n;
      n = n.parent;
    }
    return null;
  }
  contains(o: E): boolean {
    return o === this || this.descendants().includes(o);
  }
  compareDocumentPosition(o: E): number {
    const root = (() => {
      let n: E = this;
      while (n.parent) n = n.parent;
      return n;
    })();
    const order = [root, ...root.descendants()];
    return order.indexOf(o) > order.indexOf(this) ? 4 : 2;
  }
}

const el = (tag: string, text = "") => new E(tag, text);

/** Một hàng loại suất: nhãn + giá + bộ đếm [−] n [+], xếp trên dòng `top`. */
function seatRow(label: string, price: string, count: number, top: number): E {
  const minus = el("button", "−").at(300, top);
  const readout = el("div", String(count)).at(340, top);
  const plus = el("button", "+").at(380, top);
  return el("div").add(
    el("div").add(el("span", label).at(100, top), el("span", price).at(180, top)),
    el("div").add(minus, readout, plus),
  );
}

/** Hộp "Quản lý suất" đang mở. */
function openModal(...rows: E[]): E {
  const dialog = el("div");
  dialog.attrs["role"] = "dialog";
  dialog.add(
    el("h2", "Quản lý suất"),
    el("button", "×").at(500, 0), // nút đóng
    el("div").add(...rows),
    el("button", "Quay lại").at(300, 400),
    el("button", "Tiếp tục").at(400, 400),
  );
  vi.stubGlobal("document", {
    querySelectorAll: (sel: string) =>
      sel.includes("dialog") || sel.includes("aria-modal") ? [dialog] : [],
  });
  vi.stubGlobal("Node", { DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2 });
  return dialog;
}

afterEach(() => vi.unstubAllGlobals());

describe("findSeatStepper — hộp có 2 loại suất (UI 26/8/2026)", () => {
  it("GHIM hàng 'Tiêu chuẩn': đọc 152, nút '+' là nút của hàng đó", () => {
    const modal = openModal(
      seatRow("Tiêu chuẩn", "260.500 đ/tháng", 152, 0),
      seatRow("Cao cấp", "3.245.000 đ/tháng", 0, 100),
    );
    const stepper = findSeatStepper()!;
    expect(stepper).not.toBeNull();
    expect(stepper.read()).toBe(152);
    expect(stepper.scope).toBe("standard_row");

    // Nút "+" phải nằm CÙNG DÒNG với 152 (top=0), tuyệt đối không phải hàng Cao cấp.
    const inc = stepper.getIncrementButton()! as unknown as E;
    expect(inc.getBoundingClientRect().top).toBe(0);
    expect(inc.textContent).toBe("+");
    const dec = stepper.getDecrementButton()! as unknown as E;
    expect(dec.getBoundingClientRect().top).toBe(0);
    expect(dec.textContent).toBe("−");
    expect(modal.contains(inc)).toBe(true);
  });

  it("thứ tự đảo (Cao cấp đứng TRƯỚC) vẫn ghim đúng hàng Tiêu chuẩn", () => {
    openModal(
      seatRow("Cao cấp", "3.245.000 đ/tháng", 0, 0),
      seatRow("Tiêu chuẩn", "260.500 đ/tháng", 152, 100),
    );
    const stepper = findSeatStepper()!;
    expect(stepper.read()).toBe(152);
    expect((stepper.getIncrementButton()! as unknown as E).getBoundingClientRect().top).toBe(100);
  });

  it("ChatGPT đổi tên loại suất + có 2 bộ đếm ⇒ KHÔNG đoán, trả null", () => {
    openModal(
      seatRow("Gói A", "260.500 đ/tháng", 152, 0),
      seatRow("Gói B", "3.245.000 đ/tháng", 0, 100),
    );
    expect(findSeatStepper()).toBeNull();
  });

  it("hộp dựng kiểu LƯỚI (ca thật 28/8/2026): ghim theo dòng, không trả null", () => {
    // Hai nhãn + hai bộ đếm là anh em trong MỘT khung phẳng — không khung nào
    // bọc riêng hàng Tiêu chuẩn. Đúng hình dạng đã làm chết 16 lệnh mời liền.
    const flat = el("div").add(
      el("span", "Tiêu chuẩn").at(100, 0),
      el("button", "−").at(300, 0),
      el("div", "152").at(340, 0),
      el("button", "+").at(380, 0),
      el("span", "Cao cấp").at(100, 100),
      el("button", "−").at(300, 100),
      el("div", "0").at(340, 100),
      el("button", "+").at(380, 100),
    );
    openModal(flat);
    const stepper = findSeatStepper()!;
    expect(stepper).not.toBeNull();
    expect(stepper.read()).toBe(152);
    expect(stepper.scope).toBe("standard_row");
    // Cặp nút phải là cặp CÙNG DÒNG với 152, không vắt sang hàng Cao cấp.
    expect((stepper.getIncrementButton()! as unknown as E).getBoundingClientRect().top).toBe(0);
    expect((stepper.getDecrementButton()! as unknown as E).getBoundingClientRect().top).toBe(0);
  });

  it("lưới phẳng, hàng Cao cấp đứng TRƯỚC ⇒ vẫn ghim đúng hàng Tiêu chuẩn", () => {
    const flat = el("div").add(
      el("span", "Cao cấp").at(100, 0),
      el("button", "−").at(300, 0),
      el("div", "0").at(340, 0),
      el("button", "+").at(380, 0),
      el("span", "Tiêu chuẩn").at(100, 100),
      el("button", "−").at(300, 100),
      el("div", "152").at(340, 100),
      el("button", "+").at(380, 100),
    );
    openModal(flat);
    const stepper = findSeatStepper()!;
    expect(stepper.read()).toBe(152);
    expect((stepper.getIncrementButton()! as unknown as E).getBoundingClientRect().top).toBe(100);
  });

  it("nhãn nằm trong thẻ CÓ CON (gộp với giá) vẫn ghim được hàng", () => {
    // "<div>Tiêu chuẩn<span>260.500 đ/tháng</span></div>" — chữ "Tiêu chuẩn"
    // không phải leaf, bản cũ bỏ sót cả hai nhãn rồi dừng.
    const titled = (label: string, price: string, top: number) =>
      el("div").add(el("span", label).at(100, top), el("span", price).at(180, top));
    const flat = el("div").add(
      titled("Tiêu chuẩn", "260.500 đ/tháng", 0),
      el("button", "−").at(300, 0),
      el("div", "152").at(340, 0),
      el("button", "+").at(380, 0),
      titled("Cao cấp", "3.245.000 đ/tháng", 100),
      el("button", "−").at(300, 100),
      el("div", "0").at(340, 100),
      el("button", "+").at(380, 100),
    );
    openModal(flat);
    const stepper = findSeatStepper()!;
    expect(stepper.read()).toBe(152);
    expect(stepper.scope).toBe("standard_row");
  });

  it("hai bộ đếm đều nằm ngang hàng nhãn Tiêu chuẩn ⇒ KHÔNG đoán, trả null", () => {
    // Không tách được hàng nào theo dòng thì thà dừng còn hơn bấm nhầm loại
    // suất đắt gấp 12 lần.
    const flat = el("div").add(
      el("span", "Tiêu chuẩn").at(100, 0),
      el("span", "Cao cấp").at(100, 0),
      el("button", "−").at(300, 0),
      el("div", "152").at(340, 0),
      el("button", "+").at(380, 0),
      el("button", "−").at(500, 0),
      el("div", "0").at(540, 0),
      el("button", "+").at(580, 0),
    );
    openModal(flat);
    expect(findSeatStepper()).toBeNull();
  });
});

describe("findSeatStepper — biến thể nhãn", () => {
  it("nhãn gộp chung với giá trong MỘT node vẫn ghim được hàng", () => {
    // ChatGPT có thể render "Tiêu chuẩn 260.500 đ/tháng" thành một text node.
    const row = (label: string, count: number, top: number) =>
      el("div").add(
        el("span", label).at(100, top),
        el("div").add(
          el("button", "−").at(300, top),
          el("div", String(count)).at(340, top),
          el("button", "+").at(380, top),
        ),
      );
    openModal(
      row("Tiêu chuẩn 260.500 đ/tháng", 152, 0),
      row("Cao cấp 3.245.000 đ/tháng", 0, 100),
    );
    const stepper = findSeatStepper()!;
    expect(stepper.read()).toBe(152);
    expect(stepper.scope).toBe("standard_row");
  });
});

describe("findSeatStepper — hộp một loại suất (hành vi cũ, không đổi)", () => {
  it("vẫn đọc và bấm được như trước", () => {
    openModal(seatRow("Tiêu chuẩn", "260.500 đ/tháng", 47, 0));
    const stepper = findSeatStepper()!;
    expect(stepper.read()).toBe(47);
    expect(stepper.scope).toBe("single");
    expect((stepper.getIncrementButton()! as unknown as E).textContent).toBe("+");
  });
});

describe("findSeatStepper — hình dạng làm chết 21 lệnh mời 28/8/2026", () => {
  it("bộ đếm là ô <input>: vẫn ghim đúng hàng Tiêu chuẩn", () => {
    // Dấu vết ca thật: hộp có đủ nhãn ("Tiêu chuẩn"/"Cao cấp") và 5 nút bộ đếm,
    // nhưng "bộ đếm đọc ra [không có]" — đường cũ chỉ tìm con số ở LEAF TEXT nên
    // ô <input> là điểm mù, và với hộp nhiều loại suất thì đường <input> cũ lại
    // bị tắt (nó không biết ô thuộc hàng nào).
    const numberBox = (count: number, top: number) => {
      const i = el("input").at(340, top);
      i.value = String(count);
      return i;
    };
    const flat = el("div").add(
      el("span", "Tiêu chuẩn").at(100, 0),
      el("button", "−").at(300, 0),
      numberBox(152, 0),
      el("button", "+").at(380, 0),
      el("span", "Cao cấp").at(100, 100),
      el("button", "−").at(300, 100),
      numberBox(0, 100),
      el("button", "+").at(380, 100),
    );
    openModal(flat);
    const stepper = findSeatStepper()!;
    expect(stepper).not.toBeNull();
    expect(stepper.read()).toBe(152);
    expect(stepper.source).toBe("input");
    expect(stepper.scope).toBe("standard_row");
    expect((stepper.getIncrementButton()! as unknown as E).getBoundingClientRect().top).toBe(0);
    expect((stepper.getDecrementButton()! as unknown as E).getBoundingClientRect().top).toBe(0);
  });

  it("nút bị bọc nhiều lớp (khung chung xa hơn 5 tầng) vẫn ghim được", () => {
    // React bọc mỗi nút trong vài lớp div ⇒ khung chung của cặp "−"/"+" nằm
    // ngoài tầm leo 5 tầng của đường cũ, và đường cũ bỏ cuộc dù hộp bình thường.
    const wrapped = (child: E, depth: number) => {
      let node = child;
      for (let i = 0; i < depth; i++) node = el("div").add(node);
      return node;
    };
    const flat = el("div").add(
      el("span", "Tiêu chuẩn").at(100, 0),
      wrapped(el("button", "−").at(300, 0), 7),
      el("div", "152").at(340, 0),
      wrapped(el("button", "+").at(380, 0), 7),
      el("span", "Cao cấp").at(100, 100),
      wrapped(el("button", "−").at(300, 100), 7),
      el("div", "0").at(340, 100),
      wrapped(el("button", "+").at(380, 100), 7),
    );
    openModal(flat);
    const stepper = findSeatStepper()!;
    expect(stepper).not.toBeNull();
    expect(stepper.read()).toBe(152);
    expect(stepper.scope).toBe("standard_row");
    expect((stepper.getIncrementButton()! as unknown as E).textContent).toBe("+");
    expect((stepper.getIncrementButton()! as unknown as E).getBoundingClientRect().top).toBe(0);
  });

  it("ô số KHÔNG có nút kẹp hai bên thì không được nhận là bộ đếm", () => {
    // "247/250 đã gán" và giá tiền cũng là số; nhận nhầm là đọc số suất từ chỗ
    // không bao giờ nhúc nhích khi bấm "+".
    const flat = el("div").add(
      el("span", "Tiêu chuẩn").at(100, 0),
      el("div", "247").at(340, 0),
      el("span", "Cao cấp").at(100, 100),
      el("div", "0").at(340, 100),
    );
    openModal(flat);
    expect(findSeatStepper()).toBeNull();
  });
});
