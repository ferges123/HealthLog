"use client";

/**
 * The status rows of the Antigravity settings card. Each row states what the
 * CLI or the last test reported. None of them is the result of a write.
 */
import { AlertCircle, CheckCircle2, XCircle } from "lucide-react";

import type { AntigravityStatusResponse } from "@/app/api/antigravity/status/route";
import { useFormatters, useTranslations } from "@/lib/i18n/context";

type Capabilities = NonNullable<AntigravityStatusResponse["capabilities"]>;

export function CliInstallRow({
  installed,
  version,
}: {
  installed: boolean;
  version: string | null;
}) {
  const { t } = useTranslations();

  return (
    <div className="flex items-center space-x-2">
      {installed ? (
        <CheckCircle2 className="text-success h-5 w-5" />
      ) : (
        <XCircle className="text-destructive h-5 w-5" />
      )}
      <div>
        <p className="font-medium">
          {t("settings.ai.antigravity.cliInstallation")}
        </p>
        <p className="text-muted-foreground text-sm">
          {installed
            ? t("settings.ai.antigravity.cliVersion", {
                version: version ?? t("common.unknown"),
              })
            : t("settings.ai.antigravity.cliNotFound")}
        </p>
      </div>
    </div>
  );
}

export function ConnectionStateRow({
  connection,
  connectedAt,
}: {
  connection: AntigravityStatusResponse["connectionStatus"];
  connectedAt: string | null;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();

  const info = (
    {
      disconnected: {
        label: t("settings.ai.antigravity.statusDisconnected"),
        color: "text-muted-foreground",
      },
      connected: {
        label: t("settings.ai.antigravity.statusConnected"),
        color: "text-success",
      },
      auth_required: {
        label: t("settings.ai.antigravity.statusAuthRequired"),
        color: "text-warning",
      },
      error: {
        label: t("settings.ai.antigravity.statusError"),
        color: "text-destructive",
      },
    } as Record<string, { label: string; color: string }>
  )[connection] ?? { label: connection, color: "text-muted-foreground" };

  return (
    <div>
      <p className="font-medium">
        {t("settings.ai.antigravity.connectionStatus")}
      </p>
      <p className={`text-sm ${info.color}`}>{info.label}</p>
      {connectedAt && (
        <p className="text-muted-foreground text-xs">
          {t("settings.ai.antigravity.connectedAt", {
            when: fmt.dateTime(new Date(connectedAt)),
          })}
        </p>
      )}
    </div>
  );
}

export function AntigravityCapabilities({
  capabilities,
}: {
  capabilities: Capabilities;
}) {
  const { t } = useTranslations();

  return (
    <div>
      <p className="mb-2 font-medium">
        {t("settings.ai.antigravity.capabilities")}
      </p>
      <div className="grid grid-cols-2 gap-2 text-sm">
        <CapabilityRow
          on={capabilities.image}
          label={t("settings.ai.antigravity.capabilityImages")}
        />
        <CapabilityRow
          on={capabilities.embeddedContext}
          label={t("settings.ai.antigravity.capabilityPdfNative")}
        />
        <CapabilityRow
          on={false}
          label={t("settings.ai.antigravity.capabilityTools")}
        />
        <CapabilityRow
          on={false}
          label={t("settings.ai.antigravity.capabilityAudio")}
        />
      </div>
    </div>
  );
}

function CapabilityRow({ on, label }: { on: boolean; label: string }) {
  const Icon = on ? CheckCircle2 : XCircle;
  return (
    <div className="flex items-center space-x-2">
      <Icon
        className={on ? "text-success h-4 w-4" : "text-destructive h-4 w-4"}
      />
      <span>{label}</span>
    </div>
  );
}

/** The warning that the CLI sends data to Google, shown on every state. */
export function ExternalProcessingNotice() {
  const { t } = useTranslations();

  return (
    <div className="border-warning bg-warning/10 flex items-start space-x-2 rounded-lg border p-3">
      <AlertCircle className="text-warning mt-0.5 h-5 w-5 shrink-0" />
      <div className="text-sm">
        <p className="font-medium">
          {t("settings.ai.antigravity.externalProcessingTitle")}
        </p>
        <p>{t("settings.ai.antigravity.externalProcessingBody")}</p>
      </div>
    </div>
  );
}
