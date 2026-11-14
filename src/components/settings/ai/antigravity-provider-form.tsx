"use client";

/**
 * Antigravity CLI provider card for Settings, AI.
 *
 * Shows whether the CLI is installed and the state of the user's profile. The
 * connection test starts the CLI on that profile and sends no health data. The
 * login itself runs in a terminal on the HealthLog host, and the dialog shows
 * the command. Once connected, the card lists the models the CLI offers and
 * saves the user's choice.
 */

import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useTranslations } from "@/lib/i18n/context";
import { AntigravityModelPicker } from "./antigravity-model-picker";
import { AntigravityStepsDialog } from "./antigravity-steps-dialog";
import {
  AntigravityCapabilities,
  CliInstallRow,
  ConnectionStateRow,
  ExternalProcessingNotice,
} from "./antigravity-status-rows";
import { reasonText, useAntigravityProfile } from "./use-antigravity-profile";

export function AntigravityProviderForm({
  onProviderChanged,
}: {
  onProviderChanged?: () => void;
}) {
  const { t } = useTranslations();
  const profile = useAntigravityProfile({ onProviderChanged });
  const {
    status,
    loading,
    loadFailed,
    busy,
    notice,
    models,
    connected,
    stepsVariant,
  } = profile;

  const stepsTitle =
    stepsVariant === "disconnect"
      ? t("settings.ai.antigravity.stepsDisconnectTitle")
      : t("settings.ai.antigravity.connectButton");

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin motion-reduce:animate-none" />
        </CardContent>
      </Card>
    );
  }

  if (loadFailed || !status) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("settings.ai.antigravity.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-destructive text-sm">
            {t("settings.ai.antigravity.reasonFailed")}
          </p>
        </CardContent>
      </Card>
    );
  }

  const hasProfile = status.profileId !== null;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t("settings.ai.antigravity.title")}</CardTitle>
          <CardDescription>
            {t("settings.ai.antigravity.description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <CliInstallRow
            installed={status.cliInstalled}
            version={status.cliVersion}
          />
          <ConnectionStateRow
            connection={status.connectionStatus}
            connectedAt={status.connectedAt}
          />

          {notice && (
            <p role="status" className="text-muted-foreground text-sm">
              {notice}
            </p>
          )}

          {connected && models && (
            <AntigravityModelPicker
              models={models.models}
              selectedModel={models.selectedModel}
              disabled={busy !== null}
              emptyText={reasonText(t, models.reason ?? "no_models")}
              onChange={(model) => void profile.changeModel(model)}
            />
          )}

          {status.capabilities && (
            <AntigravityCapabilities capabilities={status.capabilities} />
          )}

          <ExternalProcessingNotice />

          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => void profile.connect()}
              disabled={busy !== null}
            >
              {busy === "connect" && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
              )}
              {t("settings.ai.antigravity.connectButton")}
            </Button>
            <Button
              variant="outline"
              onClick={() => void profile.test()}
              disabled={busy !== null || !hasProfile || !status.cliInstalled}
            >
              {busy === "test" && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
              )}
              {t("settings.ai.antigravity.testConnection")}
            </Button>
            {hasProfile && (
              <ConfirmButton
                slot="settings-ai-antigravity-disconnect"
                destructive
                variant="destructive"
                size="sm"
                label={t("settings.ai.antigravity.disconnectButton")}
                title={t("settings.ai.antigravity.disconnectTitle")}
                body={t("settings.ai.antigravity.disconnectBody")}
                confirmLabel={t("settings.ai.antigravity.disconnectConfirm")}
                pending={busy === "disconnect"}
                onConfirm={() => void profile.disconnect()}
              />
            )}
          </div>
        </CardContent>
      </Card>

      <AntigravityStepsDialog
        steps={profile.steps}
        title={stepsTitle}
        onClose={profile.closeSteps}
      />
    </>
  );
}
