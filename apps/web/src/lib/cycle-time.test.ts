import { describe, expect, it } from "vitest";

import {
  formatCycleMoment,
  formatUtcDate,
  formatUtcTime,
  isMachineOnUtc,
  localUtcOffsetLabel,
} from "./cycle-time";

// Mốc chốt thật của chế độ neo-theo-chu-kỳ: 03:00 UTC = 10h giờ VN.
const BOUNDARY = "2026-09-25T03:00:00Z";

describe("mốc chu kỳ hiện theo UTC", () => {
  it("giữ nguyên giờ UTC bất kể máy đang ở múi nào", () => {
    // Nếu quên `timeZone: "UTC"` thì máy giờ VN sẽ ra 10:00 — đúng cái lệch 7
    // tiếng khiến khách và luật đọc ra hai con số cho cùng một thời điểm.
    expect(formatUtcTime("vi", BOUNDARY)).toBe("03:00");
    expect(formatUtcDate("vi", BOUNDARY)).toBe("25/09/2026");
  });

  it("luôn kèm nhãn UTC — nhãn là phần của con số", () => {
    expect(formatCycleMoment("vi", BOUNDARY)).toBe("25/09/2026 03:00 UTC");
  });

  it("mốc rỗng hoặc hỏng ra dấu gạch, không ra Invalid Date", () => {
    expect(formatCycleMoment("vi", null)).toBe("—");
    expect(formatCycleMoment("vi", "khong-phai-ngay")).toBe("—");
    expect(formatUtcDate("vi", null)).toBe("—");
  });

  it("nửa đêm UTC không bị nhảy sang ngày hôm sau", () => {
    // 2026-09-25T23:30Z ở giờ VN là 06:30 ngày 26 — chỗ dễ lệch NGÀY nhất.
    expect(formatUtcDate("vi", "2026-09-25T23:30:00Z")).toBe("25/09/2026");
  });
});

describe("chênh lệch giờ máy", () => {
  it("đảo dấu của getTimezoneOffset để nói theo lối UTC+7", () => {
    const vn = new Date();
    // getTimezoneOffset là số phút phải CỘNG để ra UTC ⇒ ngược dấu.
    vn.getTimezoneOffset = () => -420;
    expect(localUtcOffsetLabel(vn)).toBe("+7");
  });

  it("múi lẻ 30 phút vẫn đọc được", () => {
    const india = new Date();
    india.getTimezoneOffset = () => -330;
    expect(localUtcOffsetLabel(india)).toBe("+5:30");
  });

  it("múi âm dùng dấu trừ thật, không phải gạch nối", () => {
    const west = new Date();
    west.getTimezoneOffset = () => 180;
    expect(localUtcOffsetLabel(west)).toBe("−3");
  });

  it("máy đang ở đúng UTC thì khỏi nhắc chênh lệch", () => {
    const utc = new Date();
    utc.getTimezoneOffset = () => 0;
    expect(isMachineOnUtc(utc)).toBe(true);
    expect(localUtcOffsetLabel(utc)).toBe("+0");
  });
});
