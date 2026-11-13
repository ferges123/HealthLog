"use client";

/**
 * The dialog that shows the host steps from connect or disconnect. Lines
 * indented with three spaces are commands and render as code.
 */
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTranslations } from "@/lib/i18n/context";

export function AntigravityStepsDialog({
  steps,
  title,
  onClose,
}: {
  steps: string[] | null;
  title: string;
  onClose: () => void;
}) {
  const { t } = useTranslations();

  return (
    <Dialog
      open={steps !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {t("settings.ai.antigravity.description")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {(steps ?? []).map((line, index) => {
            if (line.trim() === "") return <div key={index} className="h-2" />;
            if (line.startsWith("   ")) {
              return (
                <code
                  key={index}
                  className="bg-muted block rounded px-3 py-2 font-mono text-sm break-all"
                >
                  {line.trim()}
                </code>
              );
            }
            return (
              <p key={index} className="text-sm">
                {line}
              </p>
            );
          })}
        </div>
        <DialogFooter>
          <Button onClick={onClose}>{t("common.close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
