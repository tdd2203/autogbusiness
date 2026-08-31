/** Bài hướng dẫn: dùng lượt reset để đưa mức sử dụng ChatGPT về 100%.
 *
 *  Ảnh nằm trong `src/assets/guides/chatgpt-reset-limit/` và được `import` để Vite
 *  băm tên rồi bỏ vào `dist/assets/` — nginx cache mục đó vĩnh viễn (xem
 *  `apps/web/nginx.conf`). Để trong `public/` thì rơi vào `location /` với
 *  `no-store`, mỗi lần mở popup là tải lại gần 800KB ảnh.
 */
import type { Guide } from "./types";
import webMenu from "../../assets/guides/chatgpt-reset-limit/web-01-menu.png";
import webSettings from "../../assets/guides/chatgpt-reset-limit/web-02-settings.png";
import webUseReset from "../../assets/guides/chatgpt-reset-limit/web-03-use-reset.png";
import webConfirm from "../../assets/guides/chatgpt-reset-limit/web-04-confirm.png";
import codexMenu from "../../assets/guides/chatgpt-reset-limit/codex-01-menu.png";
import codexUsage from "../../assets/guides/chatgpt-reset-limit/codex-02-usage.png";
import codexAvailable from "../../assets/guides/chatgpt-reset-limit/codex-03-available.png";
import codexUseReset from "../../assets/guides/chatgpt-reset-limit/codex-04-use-reset.png";
import codexConfirm from "../../assets/guides/chatgpt-reset-limit/codex-05-confirm.png";

const chatgptResetLimit: Guide = {
  id: "chatgpt-reset-limit",
  content: {
    vi: {
      eyebrow: "Hướng dẫn · 2 cách",
      title: "Cách reset giới hạn sử dụng ChatGPT",
      intro:
        "Khi tài khoản đã chạm giới hạn 5 giờ hoặc giới hạn hằng tuần, bạn có thể dùng một **lượt đặt lại (reset)** để đưa mức sử dụng về 100%. Mỗi lượt reset chỉ dùng được 1 lần mỗi tháng.",
      sections: [
        {
          heading: "Cách 1 — Trên web chatgpt.com",
          steps: [
            {
              title: "Mở menu tài khoản",
              body: "Ở góc dưới cùng bên trái, bấm vào tên gói / workspace của bạn để mở menu, rồi chọn **Cài đặt**.",
              image: webMenu,
              imageAlt: "Menu tài khoản trong thanh bên",
              caption: "Thanh bên → menu tài khoản → Cài đặt",
            },
            {
              title: "Vào cửa sổ Cài đặt",
              body: "Cửa sổ cài đặt mở ra ở tab **General** (Chung). Danh sách mục nằm ở cột bên trái.",
              image: webSettings,
              imageAlt: "Cửa sổ cài đặt, tab Chung",
              caption: "Cài đặt → Chung",
              imageMaxWidth: 560,
            },
            {
              title: "Bấm “Use reset”",
              body: "Mở mục **Usage** (Mức sử dụng) ở cột bên trái. Khi có lượt reset khả dụng, nó hiện dưới dạng một thẻ — ví dụ **Full reset (Weekly + 5 hr)** kèm ngày hết hạn — với nút **Use reset** bên phải. Bấm vào nút đó.",
              image: webUseReset,
              imageAlt: "Thẻ Full reset với nút Use reset",
              caption: "Usage limit resets → Use reset",
              imageMaxWidth: 640,
            },
            {
              title: "Xác nhận reset",
              body: "Hộp thoại xác nhận xuất hiện. Bấm **Use reset** để dùng ngay, hoặc **Save for later** nếu muốn giữ lượt reset lại dùng sau. Sau khi xác nhận, cả giới hạn tuần và giới hạn 5 giờ trở về 100%.",
              image: webConfirm,
              imageAlt: "Hộp thoại xác nhận reset giới hạn",
              caption: "“Do you want to reset your usage limits?” → Use reset",
              imageMaxWidth: 620,
            },
          ],
        },
        {
          heading: "Cách 2 — Trên app Codex",
          steps: [
            {
              title: "Mở menu tài khoản ở góc dưới trái",
              body: "Trong app Codex, bấm vào tên gói ở đáy thanh bên để mở menu tài khoản.",
              image: codexMenu,
              imageAlt: "App Codex với menu tài khoản mở ở góc dưới trái",
              caption: "Thanh bên Codex → menu tài khoản",
            },
            {
              title: "Chọn “Usage remaining”",
              body: "Bấm vào dòng **Usage remaining** để mở rộng phần mức sử dụng còn lại.",
              image: codexUsage,
              imageAlt: "Menu tài khoản Codex với Usage remaining được chọn",
              caption: "Menu → Usage remaining",
              imageMaxWidth: 360,
            },
            {
              title: "Bấm “1 available reset”",
              body: "Menu hiện mức còn lại của giới hạn 5h và giới hạn tuần. Nếu có lượt reset, dòng **1 available reset** xuất hiện — bấm vào đó.",
              image: codexAvailable,
              imageAlt: "Menu mở rộng hiển thị 1 available reset",
              caption: "Usage remaining → 1 available reset",
              imageMaxWidth: 300,
            },
            {
              title: "Bấm “Use reset” trong cửa sổ Usage",
              body: "Cửa sổ **Usage** mở ra với nhãn xanh **1 available**. Bấm **Use reset** ở thẻ Full reset (Weekly + 5 hr).",
              image: codexUseReset,
              imageAlt: "Cửa sổ Usage với nút Use reset",
              caption: "Usage limit resets → Use reset",
              imageMaxWidth: 560,
            },
            {
              title: "Bấm “Confirm” để xác nhận",
              body: "Nút đổi thành **Confirm**. Bấm lần nữa để chốt — cả hai giới hạn trở về 100% và lượt reset bị dùng hết.",
              image: codexConfirm,
              imageAlt: "Cửa sổ Usage với nút Confirm",
              caption: "Use reset → Confirm",
              imageMaxWidth: 560,
            },
          ],
        },
      ],
      notes: [
        "Mỗi lượt reset **chỉ dùng được 1 lần mỗi tháng** và có ngày hết hạn.",
        "Nếu mục “Lượt đặt lại giới hạn sử dụng” trống thì hiện chưa có lượt nào — chờ đến khi giới hạn tự đặt lại theo thời gian hiển thị.",
        "Giới hạn này dùng chung cho Codex, Công việc, Tác nhân và ChatGPT cho Excel; các cuộc trò chuyện thường không tính vào đây.",
      ],
    },
    "zh-CN": {
      eyebrow: "使用指南 · 2 种方法",
      title: "如何重置 ChatGPT 使用额度",
      intro:
        "当账号触及 5 小时额度或每周额度时，你可以使用一次**重置额度（reset）**把用量恢复到 100%。每次重置每月只能用 1 次。",
      sections: [
        {
          heading: "方法一 — 在网页版 chatgpt.com",
          steps: [
            {
              title: "打开账号菜单",
              body: "在左下角点击你的套餐 / 工作区名称打开菜单，然后选择**设置**。",
              image: webMenu,
              imageAlt: "侧边栏中的账号菜单",
              caption: "侧边栏 → 账号菜单 → 设置",
            },
            {
              title: "进入设置窗口",
              body: "设置窗口会停在 **General**（通用）标签页，左侧一栏是各项目录。",
              image: webSettings,
              imageAlt: "设置窗口的通用标签页",
              caption: "设置 → 通用",
              imageMaxWidth: 560,
            },
            {
              title: "点击“Use reset”",
              body: "在左侧打开 **Usage**（用量）。有可用的重置次数时，会显示成一张卡片 — 例如 **Full reset (Weekly + 5 hr)** 并附到期日 — 右边带 **Use reset** 按钮，点它。",
              image: webUseReset,
              imageAlt: "带 Use reset 按钮的 Full reset 卡片",
              caption: "Usage limit resets → Use reset",
              imageMaxWidth: 640,
            },
            {
              title: "确认重置",
              body: "弹出确认框。点 **Use reset** 立即使用，或点 **Save for later** 把这次重置留到以后。确认后每周额度和 5 小时额度都会回到 100%。",
              image: webConfirm,
              imageAlt: "重置额度的确认弹窗",
              caption: "“Do you want to reset your usage limits?” → Use reset",
              imageMaxWidth: 620,
            },
          ],
        },
        {
          heading: "方法二 — 在 Codex 应用",
          steps: [
            {
              title: "点开左下角的账号菜单",
              body: "在 Codex 应用里，点击侧边栏底部的套餐名称打开账号菜单。",
              image: codexMenu,
              imageAlt: "Codex 应用左下角展开的账号菜单",
              caption: "Codex 侧边栏 → 账号菜单",
            },
            {
              title: "选择“Usage remaining”",
              body: "点击 **Usage remaining** 一行，展开剩余用量。",
              image: codexUsage,
              imageAlt: "Codex 账号菜单中选中 Usage remaining",
              caption: "菜单 → Usage remaining",
              imageMaxWidth: 360,
            },
            {
              title: "点击“1 available reset”",
              body: "菜单会显示 5 小时额度和每周额度的剩余量。若有可用重置，会出现 **1 available reset** 一行 — 点击它。",
              image: codexAvailable,
              imageAlt: "展开后显示 1 available reset 的菜单",
              caption: "Usage remaining → 1 available reset",
              imageMaxWidth: 300,
            },
            {
              title: "在 Usage 窗口点击“Use reset”",
              body: "**Usage** 窗口打开，带绿色标签 **1 available**。在 Full reset (Weekly + 5 hr) 卡片上点 **Use reset**。",
              image: codexUseReset,
              imageAlt: "带 Use reset 按钮的 Usage 窗口",
              caption: "Usage limit resets → Use reset",
              imageMaxWidth: 560,
            },
            {
              title: "点击“Confirm”确认",
              body: "按钮会变成 **Confirm**，再点一次即可确认 — 两项额度都回到 100%，这次重置也就用掉了。",
              image: codexConfirm,
              imageAlt: "带 Confirm 按钮的 Usage 窗口",
              caption: "Use reset → Confirm",
              imageMaxWidth: 560,
            },
          ],
        },
      ],
      notes: [
        "每次重置**每月只能用 1 次**，并且有到期日。",
        "如果“使用额度重置”一栏是空的，说明当前没有可用次数 — 等额度按显示的时间自动恢复即可。",
        "该额度由 Codex、任务、智能体和 ChatGPT for Excel 共用；普通对话不计入其中。",
      ],
    },
  },
};

export default chatgptResetLimit;
