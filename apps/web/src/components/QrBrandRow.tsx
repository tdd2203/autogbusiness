/**
 * QrBrandRow — hàng thương hiệu "napas 247 | <ngân hàng> | VietQR" phía trên mã QR,
 * tô ĐÚNG MÀU logo gốc: napas (navy) + 247 (cam), tên ngân hàng (teal), VietQR
 * ("Viet" xanh + "QR" đỏ + ™). Dùng chung cho TopupModal + OrderQrModal để 2 modal
 * QR đồng nhất. App chỉ có theme sáng (--surface trắng) nên màu để cố định.
 */
export default function QrBrandRow({ bankName }: { bankName?: string | null }) {
  return (
    <div style={row}>
      <span style={mark}>
        <span style={{ color: "#152a6c" }}>napas</span>
        <sup style={{ color: "#f6871f", fontSize: "0.6em", fontWeight: 800, marginLeft: 2 }}>247</sup>
      </span>

      {bankName ? (
        <>
          <span style={sep} />
          <span style={{ ...mark, color: "#00857a", letterSpacing: "0.02em" }}>{bankName}</span>
        </>
      ) : null}

      <span style={sep} />
      <span style={mark}>
        <span style={{ color: "#004a9f" }}>Viet</span>
        <span style={{ color: "#ed1b2e" }}>QR</span>
        <sup style={{ color: "#004a9f", fontSize: "0.5em", fontWeight: 700 }}>™</sup>
      </span>
    </div>
  );
}

const row: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "center", gap: 10, width: "100%", flexWrap: "wrap" };
const mark: React.CSSProperties = { fontFamily: "var(--font-sans)", fontWeight: 800, fontSize: 15, letterSpacing: "-0.01em", lineHeight: 1, display: "inline-flex", alignItems: "baseline" };
const sep: React.CSSProperties = { width: 1, height: 15, background: "var(--border-strong)", flexShrink: 0 };
