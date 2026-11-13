"use client";

/**
 * State and actions of the Antigravity settings card: the profile status, the
 * model list, the connection test, the connect and disconnect steps, and the
 * model choice. The card renders these; this file talks to the API.
 */
import { useEffect, useState } from "react";

import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { apiGet, apiPatch, apiPost } from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";
import { useTranslations } from "@/lib/i18n/context";
import type { AntigravityStatusResponse } from "@/app/api/antigravity/status/route";
import type { AntigravityTestResponse } from "@/app/api/antigravity/test/route";
import type { AntigravityAuthenticateResponse } from "@/app/api/antigravity/authenticate/route";
import type { AntigravityDisconnectResponse } from "@/app/api/antigravity/disconnect/route";
import type {
  AntigravityModelsReason,
  AntigravityModelsResponse,
} from "@/app/api/antigravity/models/route";
import type { AntigravityModelResponse } from "@/app/api/antigravity/model/route";

type Busy = "connect" | "test" | "disconnect" | "model";
type Translate = ReturnType<typeof useTranslations>["t"];

/** The sentence for a reason a test or a model list did not pass. */
export function reasonText(
  t: Translate,
  reason: NonNullable<
    AntigravityTestResponse["reason"] | AntigravityModelsReason
  >,
): string {
  switch (reason) {
    case "not_set_up":
      return t("settings.ai.antigravity.reasonNotSetUp");
    case "profile_missing":
      return t("settings.ai.antigravity.reasonProfileMissing");
    case "cli_unavailable":
      return t("settings.ai.antigravity.cliNotFound");
    case "auth_required":
      return t("settings.ai.antigravity.statusAuthRequired");
    case "timeout":
      return t("settings.ai.antigravity.reasonTimeout");
    case "cli_error":
      return t("settings.ai.antigravity.reasonFailed");
    case "no_models":
      return t("settings.ai.antigravity.noModels");
  }
}

export function useAntigravityProfile(callbacks?: {
  onProviderChanged?: () => void;
}) {
  const { t } = useTranslations();

  const [status, setStatus] = useState<AntigravityStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [steps, setSteps] = useState<string[] | null>(null);
  const [stepsVariant, setStepsVariant] = useState<
    "connect" | "disconnect" | null
  >(null);
  const [models, setModels] = useState<AntigravityModelsResponse | null>(null);

  const connected = status?.connectionStatus === "connected";
  const connectedAt = status?.connectedAt ?? null;

  useEffect(() => {
    let active = true;
    apiGet<AntigravityStatusResponse>("/api/antigravity/status")
      .then((data) => {
        if (active) setStatus(data);
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  // The model list comes from the CLI, which starts a process. Load it only
  // when the profile is connected, and again after each successful test.
  useEffect(() => {
    if (!connected) return;
    let active = true;
    apiGet<AntigravityModelsResponse>("/api/antigravity/models")
      .then((data) => {
        if (active) setModels(data);
      })
      .catch(() => {
        if (active) {
          setModels({ models: [], selectedModel: null, reason: "cli_error" });
        }
      });
    return () => {
      active = false;
    };
  }, [connected, connectedAt]);

  async function refresh() {
    setStatus(
      await apiGet<AntigravityStatusResponse>("/api/antigravity/status"),
    );
  }

  async function run(kind: Busy, action: () => Promise<void>) {
    setBusy(kind);
    setNotice(null);
    try {
      await action();
    } catch (error) {
      setNotice(
        localizedApiError(error, t, "settings.ai.antigravity.reasonFailed"),
      );
    } finally {
      setBusy(null);
    }
  }

  function connect() {
    return run("connect", async () => {
      const result = await apiPost<AntigravityAuthenticateResponse>(
        "/api/antigravity/authenticate",
      );
      await apiPatch("/api/user/ai-provider", { provider: "ANTIGRAVITY_CLI" });
      callbacks?.onProviderChanged?.();
      setStepsVariant("connect");
      setSteps(result.instructions);
      await refresh();
    });
  }

  function test() {
    return run("test", async () => {
      // The test starts the CLI and can take up to a minute, so the default
      // request timeout does not apply.
      const result = await apiPost<AntigravityTestResponse>(
        "/api/antigravity/test",
        undefined,
        { signal: null },
      );
      if (result.reason) setNotice(reasonText(t, result.reason));
      await refresh();
    });
  }

  function disconnect() {
    return run("disconnect", async () => {
      const result = await apiPost<AntigravityDisconnectResponse>(
        "/api/antigravity/disconnect",
      );
      await apiPatch("/api/user/ai-provider", { provider: null });
      callbacks?.onProviderChanged?.();
      setStepsVariant("disconnect");
      setSteps(result.instructions);
      await refresh();
    });
  }

  function changeModel(model: string | null) {
    return run("model", async () => {
      const result = await apiPatch<AntigravityModelResponse>(
        "/api/antigravity/model",
        { model },
      );
      setModels((current) =>
        current ? { ...current, selectedModel: result.selectedModel } : current,
      );
      toastWrittenOutcome("success", t("settings.ai.antigravity.modelSaved"));
    });
  }

  return {
    status,
    loading,
    loadFailed,
    busy,
    notice,
    steps,
    stepsVariant,
    models,
    connected,
    closeSteps: () => setSteps(null),
    connect,
    test,
    disconnect,
    changeModel,
  };
}
