import { KeyRound } from "lucide-react";
import type { TabProps, TermixApp } from "@termix-ssh/plugin-sdk/frontend";
import { createDashlaneApi } from "./api";
import { DashlaneTab } from "./DashlaneTab";

const TAB_ID = "dashlane";

export function activate(app: TermixApp): void {
  const api = createDashlaneApi(app.api);

  app.registerRailItem({
    id: TAB_ID,
    icon: KeyRound,
    titleKey: "tab.title",
    kind: "tab",
    permission: "use",
  });
  app.registerTab(
    TAB_ID,
    (props: TabProps) => <DashlaneTab {...props} api={api} />,
    {
      icon: KeyRound,
      titleKey: "tab.title",
      singleton: true,
      hostless: true,
    },
  );
}
