import {
  humanClick,
  queryByAnyText,
  querySelectorFirst,
  randomDelay,
  sleep,
} from "../../../human";
import { ROLE_LABELS, findUiControlByTexts } from "../../../i18n-ui";
import { SELECTORS, TEXT_FALLBACKS } from "../../../selectors";
import { findRowMenuButton } from "../../member-row";
import { recordIfText, step, type Ctx, type HarvestItem } from "../ctx";
import { navigateSpaVerified } from "../nav";
import { harvestRevokeFlow } from "../revoke-probe/harvest-revoke-flow";
import { pressEscape, waitForDialog, waitForDialogClose, waitForMenu } from "../wait";

export async function harvestMembers(
  ctx: Ctx,
  out: HarvestItem[],
): Promise<void> {
  await step(ctx, "Mở /admin/members");
  const ok = await navigateSpaVerified("/admin/members");
  if (!ok) {
    await step(ctx, "⚠ Bỏ qua /admin/members (nav fail)");
    return;
  }

  // 3 tabs
  await step(ctx, "Đọc 3 tab Members");
  for (const [key, texts] of [
    ["tab_active_members", TEXT_FALLBACKS.tabActiveMembers],
    ["tab_pending_invites", TEXT_FALLBACKS.tabPendingInvites],
    ["tab_pending_requests", TEXT_FALLBACKS.tabPendingRequests],
  ] as const) {
    recordIfText(out, ctx, key, findUiControlByTexts(texts));
  }

  // Mở invite dialog
  await step(ctx, "Mở dialog Mời thành viên");
  const inviteOpen = findUiControlByTexts(TEXT_FALLBACKS.inviteButtonOpen);
  if (inviteOpen) {
    recordIfText(out, ctx, "invite_button_open", inviteOpen);
    await humanClick(inviteOpen);
    const dialog = await waitForDialog(4000);
    if (dialog) {
      await step(ctx, "Đọc nút Submit + Add-more");
      const submit = queryByAnyText(
        "button",
        TEXT_FALLBACKS.inviteSubmitButton,
        dialog,
      );
      recordIfText(out, ctx, "invite_submit_button", submit);

      const addMore =
        queryByAnyText("button", TEXT_FALLBACKS.inviteAddMoreButton, dialog) ??
        queryByAnyText("a", TEXT_FALLBACKS.inviteAddMoreButton, dialog);
      recordIfText(out, ctx, "invite_add_more_button", addMore);

      await step(ctx, "Mở dropdown Role → đọc 3 option");
      const roleSelect = querySelectorFirst<HTMLElement>(
        SELECTORS.inviteRoleSelect,
        dialog,
      );
      if (roleSelect && roleSelect.tagName !== "SELECT") {
        await humanClick(roleSelect);
        await sleep(700);
        for (const role of ["owner", "admin", "member"] as const) {
          const opt =
            queryByAnyText('[role="menuitem"]', ROLE_LABELS[role]) ??
            queryByAnyText('[role="option"]', ROLE_LABELS[role]) ??
            queryByAnyText('[role="menuitemradio"]', ROLE_LABELS[role]) ??
            queryByAnyText("li", ROLE_LABELS[role]);
          recordIfText(out, ctx, `invite_role_${role}`, opt);
        }
        await pressEscape();
      } else if (roleSelect && roleSelect.tagName === "SELECT") {
        const sel = roleSelect as HTMLSelectElement;
        for (const role of ["owner", "admin", "member"] as const) {
          const opt = Array.from(sel.options).find(
            (o) =>
              o.value === role ||
              (o.textContent ?? "").trim().toLowerCase().includes(role),
          );
          const t = (opt?.textContent ?? "").trim();
          if (t) {
            out.push({ control_key: `invite_role_${role}`, label_text: t });
            ctx.scanned += 1;
          }
        }
      }

      await pressEscape();
      await waitForDialogClose();
    } else {
      await step(ctx, "⚠ Dialog Invite không mở (skip)");
    }
  }

  // Row menu
  await step(ctx, "Tìm row member để mở menu ...");
  const rows: HTMLElement[] = [];
  for (const sel of SELECTORS.memberRow) {
    document.querySelectorAll<HTMLElement>(sel).forEach((r) => rows.push(r));
    if (rows.length > 0) break;
  }
  const targetRow = rows[rows.length - 1] ?? null;
  if (targetRow) {
    const menuBtn = findRowMenuButton(targetRow);
    if (menuBtn) {
      recordIfText(out, ctx, "member_row_menu_button", menuBtn);
      await humanClick(menuBtn);
      await waitForMenu();
      await sleep(300);

      await step(ctx, "Đọc menu items Remove / Change role");
      const removeItem = queryByAnyText(
        '[role="menuitem"]',
        TEXT_FALLBACKS.removeMenuItem,
      );
      recordIfText(out, ctx, "menu_remove_member", removeItem);

      const changeItem = queryByAnyText(
        '[role="menuitem"]',
        TEXT_FALLBACKS.changeRoleMenuItem,
      );
      recordIfText(out, ctx, "menu_change_role", changeItem);

      if (removeItem) {
        await step(ctx, "Mở confirm Remove (sẽ ESC để hủy)");
        await randomDelay(250, 500);
        await humanClick(removeItem);
        const confirmDialog = await waitForDialog(3000);
        if (confirmDialog) {
          const confirmBtn = queryByAnyText(
            "button",
            TEXT_FALLBACKS.confirmRemoveButton,
            confirmDialog,
          );
          recordIfText(out, ctx, "confirm_remove_button", confirmBtn);
          await pressEscape();
          await waitForDialogClose();
        } else {
          await pressEscape();
        }
      } else {
        await pressEscape();
      }
    } else {
      await step(ctx, "⚠ Row không có nút ... (skip)");
    }
  } else {
    await step(ctx, "⚠ Workspace chưa có member nào (skip row menu)");
  }

  // Pending tab → revoke menu (auto-tạo probe invite nếu trống)
  await harvestRevokeFlow(ctx, out);
}
