import { describe, expect, it } from "vitest";

import {
  formatCycleMoment,
  formatUtcDate,
  formatUtcTime,
  formatVnDate,
  formatVnMoment,
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

describe("mốc hiện cho người dùng — giờ Việt Nam", () => {
  it("đổi 03:00 UTC thành 10:00 giờ VN", () => {
    // Cùng một khoảnh khắc, hai cách viết. Người bán đọc 10:00 chứ không trừ nhẩm.
    expect(formatVnMoment("vi", BOUNDARY)).toContain("10:00");
    expect(formatVnMoment("vi", BOUNDARY)).toContain("25/09/2026");
  });

  it("ép múi VN, KHÔNG lấy giờ máy", () => {
    // 2026-09-25T20:00Z là 03:00 ngày 26 giờ VN — nếu lấy giờ máy (CI chạy UTC)
    // sẽ ra ngày 25, tức hai người nhìn cùng một hạn ra hai ngày khác nhau.
    expect(formatVnDate("vi", "2026-09-25T20:00:00Z")).toBe("26/09/2026");
  });

  it("mốc rỗng ra dấu gạch", () => {
    expect(formatVnMoment("vi", null)).toBe("—");
    expect(formatVnDate("vi", "hong")).toBe("—");
  });
});
