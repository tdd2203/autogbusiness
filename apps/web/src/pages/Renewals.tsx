import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n";
import type { AddedMember } from "../types";
import { RenewalsPanel } from "../components/RenewalsPanel";

/**
 * Trang "Gia hạn" (tách khỏi sub-tab trong "Email đã add" — nay là mục riêng ở
 * sidebar). Dùng chính danh sách `/api/v1/added-members` (gom XUYÊN workspace,
 * đã lọc visibility ở backend) rồi để RenewalsPanel lọc ra thành viên sắp/đã hết
 * hạn. Cùng queryKey với view mặc định của AddedEmails → react-query dùng chung cache.
 */
export default function Renewals() {
  const t = useT();

  const { data: members = [] } = useQuery({
    queryKey: ["added-members", "self"],
    queryFn: () => api<AddedMember[]>("/api/v1/added-members"),
    // Hạn dùng trôi theo giờ và job nền vẫn xoá/gia hạn trong lúc trang đang mở,
    // nên danh sách tự nạp lại mỗi phút thay vì đứng im tới lúc F5.
    refetchInterval: 60_000,
  });

  return (
    <div className="page-fade">
      <div style={{ marginBottom: 32 }}>
        <div className="breadcrumb">{t("nav.renewals")}</div>
        <h1 className="display-h1">{t("renewals.title")}</h1>
      </div>
      <RenewalsPanel members={members} />
    </div>
  );
}
