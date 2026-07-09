/**
 * Tab "Thanh toán" của workspace — hiển thị panel billing (giá/seat, chu kỳ,
 * tổng chi, dự kiến kỳ sau, lịch sử hoá đơn). Tách khỏi tab Thành viên để không
 * chèn trên đầu danh sách thành viên.
 */
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { Workspace } from "../types";
import { WorkspaceBillingPanel } from "../components/WorkspaceBillingPanel";
import { useT } from "../i18n";

export default function WorkspaceBilling() {
  const { workspaceId } = useParams();
  const t = useT();
  const { data: workspace, isLoading } = useQuery({
    // Cùng queryKey với WorkspaceLayout → react-query auto-dedupe, không refetch.
    queryKey: ["workspace", workspaceId],
    queryFn: () => api<Workspace>(`/api/v1/workspaces/${workspaceId}`),
    enabled: !!workspaceId,
  });

  if (isLoading || !workspace) {
    return (
      <p style={{ fontSize: 13, color: "var(--ink-3)" }}>
        {t("common.loading")}
      </p>
    );
  }
  return <WorkspaceBillingPanel workspace={workspace} />;
}
