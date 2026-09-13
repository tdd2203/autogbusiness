/**
 * KHUNG MA `role="dialog"` KHÔNG ĐƯỢC TÍNH LÀ HỘP THOẠI ĐANG MỞ.
 *
 * Ca thật khaialphauni003@gmail.com 10/9/2026: ChatGPT gỡ member xong, hộp xác
 * nhận đã tắt, nhưng trong DOM còn một khung `role="dialog"` rỗng đứng TRƯỚC.
 * `document.querySelector` lấy đúng cái khung đó ⇒ "dialog chưa đóng" đúng mãi
 * mãi ⇒ lệnh gỡ chờ hết 30s rồi báo `VERIFY_FAILED` kèm lý do đoán mò "ChatGPT
 * hỏi OTP/2FA" — trong khi ChatGPT đã gỡ xong từ lâu. Dấu vết nhận ra ca này:
 * `openDialogText()` trả về RỖNG (hộp thật luôn có chữ và có nút).
 *
 * Repo không có jsdom → dựng document giả tối thiểu, đủ cho `querySelectorAll`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../human", () => ({
  humanClick: vi.fn(async () => {}),
  sleep: vi.fn(async () => {}),
  normalizeMatchText: (s: string) =>
    s.toLowerCase().replace(/\s+/g, " ").trim(),
}));

const { humanClick } = await import("../human");
const {
  answerPaidSeatDialog,
  confirmDialogOpen,
  openDialogText,
  paidSeatDialogOpen,
  visibleDialogEl,
} = await import("./dialog-commit");

type DialogSpec = {
  text?: string;
  buttons?: string[];
  state?: "open" | "closed";
  ariaHidden?: boolean;
  hidden?: boolean;
};

function fakeDialog(spec: DialogSpec) {
  const buttons = (spec.buttons ?? []).map((t) => ({ textContent: t }));
  return {
    textContent: spec.text ?? "",
    // Tab nền không vẽ layout → hộp thật cũng cho hình học rỗng. `dialogAlive`
    // CỐ Ý không đo hình học, nên fake ở đây cũng không cần dựng.
    hasAttribute: (name: string) => name === "hidden" && spec.hidden === true,
    getAttribute: (name: string) => {
      if (name === "data-state") return spec.state ?? "open";
      if (name === "aria-hidden") return spec.ariaHidden ? "true" : null;
      return null;
    },
    querySelector: (sel: string) =>
      sel.includes("button") ? (buttons[0] ?? null) : null,
    querySelectorAll: () => buttons,
  };
}

function stubDialogs(...specs: DialogSpec[]): void {
  const nodes = specs.map(fakeDialog);
  // Chỉ selector hộp thoại mới ra khung; quét `button` toàn trang (đường lui nhận
  // hộp suất theo cặp nút) ra rỗng — trang không có nút nào ngoài hộp.
  vi.stubGlobal("document", {
    querySelectorAll: (sel: string) => (sel.includes("dialog") ? nodes : []),
  });
}

const CONFIRM = {
  text: "Gỡ bỏ Khai khỏi GPT1?Việc gỡ bỏ sẽ khiến họ mất quyền truy cập.",
  buttons: ["Hủy bỏ", "Gỡ bỏ khỏi không gian làm việc"],
};
const PAID_SEAT = {
  text:
    "Remove the paid seat?Khai has been removed. Removing 1 Standard seat " +
    "lowers your monthly bill by ₫286,550 starting September 11, 2026.",
  buttons: ["Keep paid seat", "Remove paid seat"],
};

describe("visibleDialogEl — chỉ đếm hộp thoại còn sống", () => {
  it("khung rỗng đứng trước hộp thật → lấy hộp thật, không lấy khung rỗng", () => {
    stubDialogs({ text: "" }, CONFIRM);

    expect(confirmDialogOpen()).toBe(true);
    expect(openDialogText()).toContain("Gỡ bỏ Khai");
  });

  it("CHỈ còn khung rỗng → coi như không có hộp nào (dialog đã đóng)", () => {
    stubDialogs({ text: "" });

    expect(visibleDialogEl()).toBeNull();
    expect(confirmDialogOpen()).toBe(false);
  });

  it("hộp đã đóng còn chờ hiệu ứng / bị ẩn → không tính", () => {
    stubDialogs(
      { ...CONFIRM, state: "closed" },
      { ...CONFIRM, ariaHidden: true },
      { ...CONFIRM, hidden: true },
    );

    expect(confirmDialogOpen()).toBe(false);
  });

  it("hai hộp cùng sống → lấy hộp SAU CÙNG (hộp bồi thêm nằm trên)", () => {
    stubDialogs(CONFIRM, PAID_SEAT);

    expect(openDialogText()).toContain("Remove the paid seat?");
    expect(paidSeatDialogOpen()).toBe(true);
  });
});

describe("answerPaidSeatDialog — giữ giữa kỳ, gỡ trong ngày chốt", () => {
  const clickedText = () =>
    (vi.mocked(humanClick).mock.calls.at(-1)?.[0] as { textContent: string }).textContent;

  it("mặc định (giữa kỳ) → bấm Giữ suất", async () => {
    vi.mocked(humanClick).mockClear();
    stubDialogs(PAID_SEAT);

    await expect(answerPaidSeatDialog("[t]")).resolves.toBe("kept");
    expect(clickedText()).toBe("Keep paid seat");
  });

  it("release:true (ngày chốt) → bấm Gỡ suất, báo released", async () => {
    vi.mocked(humanClick).mockClear();
    stubDialogs(PAID_SEAT);

    await expect(answerPaidSeatDialog("[t]", { release: true })).resolves.toBe("released");
    expect(clickedText()).toBe("Remove paid seat");
  });

  it("release:true mà ChatGPT đổi nhãn nút gỡ → rơi về Giữ, không bấm bừa", async () => {
    vi.mocked(humanClick).mockClear();
    stubDialogs({ ...PAID_SEAT, buttons: ["Keep paid seat", "Bỏ qua"] });

    await expect(answerPaidSeatDialog("[t]", { release: true })).resolves.toBe("kept");
    expect(clickedText()).toBe("Keep paid seat");
  });

  it("hộp xác nhận gỡ member thường → none, không bấm gì kể cả release:true", async () => {
    vi.mocked(humanClick).mockClear();
    stubDialogs(CONFIRM);

    await expect(answerPaidSeatDialog("[t]", { release: true })).resolves.toBe("none");
    expect(humanClick).not.toHaveBeenCalled();
  });
});

/**
 * ĐƯỜNG LUI: hộp "Gỡ suất trả phí?" không mang `role="dialog"` thì nhận theo CẶP
 * nút giữ/gỡ. Hai lệnh gỡ 12–13/9/2026 kết thúc "không còn hộp nào" mà ảnh user
 * chụp ngay sau đó hộp vẫn nằm trên trang; DOM thật của hộp chưa quan sát được
 * nên chừa đường này bên cạnh quãng nán chờ hộp hiện muộn.
 */
describe("hộp suất KHÔNG mang role=dialog → nhận theo cặp nút giữ/gỡ", () => {
  type FakeNode = {
    isButton: boolean;
    textContent: string;
    parentElement: FakeNode | null;
    children: FakeNode[];
    contains: (n: unknown) => boolean;
    closest: (sel: string) => FakeNode | null;
    getAttribute: (name: string) => string | null;
    hasAttribute: (name: string) => boolean;
    querySelector: (sel: string) => FakeNode | null;
    querySelectorAll: (sel: string) => FakeNode[];
  };
  const buttonsIn = (n: FakeNode): FakeNode[] =>
    n.children.flatMap((c) => (c.isButton ? [c] : buttonsIn(c)));
  function node(
    text: string,
    children: FakeNode[] = [],
    opts: { button?: boolean; closed?: boolean } = {},
  ): FakeNode {
    const self: FakeNode = {
      isButton: opts.button === true,
      textContent: text + children.map((c) => c.textContent).join(""),
      parentElement: null,
      children,
      contains: (n) => n === self || children.some((c) => c.contains(n)),
      closest: (sel) =>
        opts.closed && sel.includes("closed") ? self : (self.parentElement?.closest(sel) ?? null),
      getAttribute: () => null,
      hasAttribute: () => false,
      querySelector: (sel) => (sel.includes("button") ? (buttonsIn(self)[0] ?? null) : null),
      querySelectorAll: (sel) => (sel === "button" ? buttonsIn(self) : []),
    };
    for (const c of children) c.parentElement = self;
    return self;
  }
  const button = (label: string) => node(label, [], { button: true });

  /** Trang: không có `role="dialog"` nào sống, chỉ có các nút ở đâu đó trong cây. */
  function stubPage(body: FakeNode): void {
    vi.stubGlobal("document", {
      body,
      querySelectorAll: (sel: string) => (sel === "button" ? buttonsIn(body) : []),
    });
  }
  const clickedText = () =>
    (vi.mocked(humanClick).mock.calls.at(-1)?.[0] as { textContent: string }).textContent;

  function pageWithPaidSeatBox(opts: { closed?: boolean } = {}) {
    const keep = button("Keep paid seat");
    const remove = button("Remove paid seat");
    const row = node("", [keep, remove]);
    const panel = node(PAID_SEAT.text, [row], { closed: opts.closed });
    const page = node("Members · 402 members · 405 Standard seats", [button("Invite member"), panel]);
    const body = node("", [page]);
    return { body, panel, keep, remove };
  }

  it("có đủ cặp nút → khung có thân chữ suất + tiền là hộp suất; giữa kỳ bấm Giữ", async () => {
    const { body, panel } = pageWithPaidSeatBox();
    stubPage(body);

    expect(confirmDialogOpen()).toBe(true);
    expect(visibleDialogEl()).toBe(panel);
    expect(openDialogText()).toContain("Remove the paid seat?");
    expect(paidSeatDialogOpen()).toBe(true);
    expect(await answerPaidSeatDialog("[t]")).toBe("kept");
    expect(clickedText()).toBe("Keep paid seat");
  });

  it("ngày chốt (release) → bấm Gỡ suất qua đường lui này", async () => {
    stubPage(pageWithPaidSeatBox().body);

    expect(await answerPaidSeatDialog("[t]", { release: true })).toBe("released");
    expect(clickedText()).toBe("Remove paid seat");
  });

  it("chỉ một nút lẻ 'Remove seat' ngoài trang (hộp Quản lý suất) → không phải hộp suất", () => {
    const body = node("", [node("Standard seats", [button("Add seat"), button("Remove seat")])]);
    stubPage(body);

    expect(confirmDialogOpen()).toBe(false);
    expect(paidSeatDialogOpen()).toBe(false);
  });

  it("cặp nút nằm trong khung đã đóng → không tính", () => {
    stubPage(pageWithPaidSeatBox({ closed: true }).body);

    expect(confirmDialogOpen()).toBe(false);
  });
});
