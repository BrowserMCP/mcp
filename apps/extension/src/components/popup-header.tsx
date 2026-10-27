import { HelpCircleIcon, SettingsIcon } from "lucide-react";

import logo from "@/assets/logo.svg";

import { APP_NAME, DOCS_URL } from "./links";
import { Button, openPage } from "./ui";

export function PopupHeader({
  onOpenSettings,
}: {
  onOpenSettings: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-4 py-2.5">
      <div className="flex items-center gap-2">
        <img src={logo} alt="" width={30} height={30} />
        <span className="text-[15px] font-semibold tracking-[-0.02em]">
          {APP_NAME}
        </span>
      </div>
      <div className="flex items-center">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Settings"
          onClick={onOpenSettings}
        >
          <SettingsIcon className="size-5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Help"
          onClick={() => openPage(DOCS_URL)}
        >
          <HelpCircleIcon className="size-5" />
        </Button>
      </div>
    </div>
  );
}
