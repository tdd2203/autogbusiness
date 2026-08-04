/**
 * Logo Telegram — SVG nội tuyến, KHÔNG tải ảnh ngoài.
 *
 * Thay cho emoji ✈️ (user 2026-08-04): emoji render mỗi hệ điều hành một kiểu (macOS
 * xanh, Windows xám, Android khác nữa) và không phải logo Telegram — nhìn không ra
 * thương hiệu. SVG thì mọi máy giống nhau, nét ở mọi kích cỡ, và tự đứng vững ở cả
 * nền sáng lẫn nền tối vì đã có sẵn đĩa tròn màu thương hiệu.
 */
export function TelegramLogo({ size = 72 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 240 240"
      role="img"
      aria-label="Telegram"
      style={{ display: "block", flex: "0 0 auto" }}
    >
      <circle cx="120" cy="120" r="120" fill="#29A9EB" />
      <path
        fill="#fff"
        d="M52.8 118.6c35-15.2 58.3-25.3 70-30.2 33.3-13.9 40.2-16.3 44.7-16.4 1 0 3.2.2 4.7 1.4 1.2 1 1.5 2.3 1.7 3.3.2 1 .4 3.1.2 4.8-1.8 19.3-9.8 66.1-13.9 87.7-1.7 9.1-5.1 12.2-8.4 12.5-7.1.7-12.5-4.7-19.4-9.2-10.8-7.1-16.9-11.5-27.4-18.4-12.1-8-4.3-12.4 2.7-19.6 1.8-1.9 33.1-30.3 33.7-32.9.1-.3.1-1.5-.6-2.1-.7-.6-1.7-.4-2.5-.2-1.1.2-18.3 11.6-51.7 34.2-4.9 3.4-9.3 5-13.3 4.9-4.4-.1-12.8-2.5-19.1-4.5-7.7-2.5-13.8-3.8-13.3-8.1.3-2.2 3.4-4.5 9.2-6.8z"
      />
    </svg>
  );
}
