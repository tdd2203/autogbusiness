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
  vi.stubGlobal("document", { querySelectorAll: () => nodes });
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
