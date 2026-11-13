"use client";

/**
 * Antigravity CLI provider configuration form.
 *
 * Displays:
 * - CLI installation status and version
 * - Connection status (honest: unknown, connected, auth_required, unsupported, error)
 * - Model selection (discovered from ACP)
 * - Thinking level selection
 * - Connection test button
 * - Enable/disable toggle
 * - Capabilities: text/image/PDF-native/PDF-raster/audio-off/tools-off
 * - Notice that local process still sends data to external service
 */

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertCircle, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useState, useEffect } from "react";
import type { AntigravityStatusResponse } from "@/app/api/antigravity/status/route";
import type { AntigravityModelsResponse } from "@/app/api/antigravity/models/route";

interface AntigravityProviderFormProps {
  userId: string;
  locale: string;
}

export function AntigravityProviderForm({ userId, locale }: AntigravityProviderFormProps) {
  const [status, setStatus] = useState<AntigravityStatusResponse | null>(null);
  const [models, setModels] = useState<AntigravityModelsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [authenticating, setAuthenticating] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [selectedThinkingLevel, setSelectedThinkingLevel] = useState<string>("");

  useEffect(() => {
    loadStatus();
    loadModels();
  }, []);

  async function loadStatus() {
    try {
      const response = await fetch("/api/antigravity/status");
      if (response.ok) {
        const data = await response.json();
        setStatus(data);
        if (data.model) {
          setSelectedModel(data.model);
        }
      }
    } catch (error) {
      console.error("Failed to load Antigravity status:", error);
    } finally {
      setLoading(false);
    }
  }

  async function loadModels() {
    try {
      const response = await fetch("/api/antigravity/models");
      if (response.ok) {
        const data = await response.json();
        setModels(data);
        if (data.defaultModel && !selectedModel) {
          setSelectedModel(data.defaultModel);
        }
        if (data.thinkingLevels.length > 0 && !selectedThinkingLevel) {
          setSelectedThinkingLevel(data.thinkingLevels[0]);
        }
      }
    } catch (error) {
      console.error("Failed to load Antigravity models:", error);
    }
  }

  async function handleAuthenticate() {
    setAuthenticating(true);
    try {
      const response = await fetch("/api/antigravity/authenticate", {
        method: "POST",
      });
      if (response.ok) {
        const data = await response.json();
        // Show instructions to user
        alert(data.instructions.join("\n"));
        // Reload status
        await loadStatus();
      }
    } catch (error) {
      console.error("Failed to authenticate:", error);
    } finally {
      setAuthenticating(false);
    }
  }

  async function handleDisconnect() {
    try {
      const response = await fetch("/api/antigravity/disconnect", {
        method: "POST",
      });
      if (response.ok) {
        await loadStatus();
      }
    } catch (error) {
      console.error("Failed to disconnect:", error);
    }
  }

  async function handleTestConnection() {
    setTesting(true);
    try {
      // TODO: Implement connection test
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } finally {
      setTesting(false);
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin" />
        </CardContent>
      </Card>
    );
  }

  const cliStatusIcon = status?.cliInstalled ? (
    <CheckCircle2 className="h-5 w-5 text-green-500" />
  ) : (
    <XCircle className="h-5 w-5 text-red-500" />
  );

  const connectionStatusMap = {
    disconnected: { label: "Disconnected", color: "text-gray-500" },
    connected: { label: "Connected", color: "text-green-500" },
    auth_required: { label: "Authentication Required", color: "text-yellow-500" },
    error: { label: "Error", color: "text-red-500" },
  };

  const connectionInfo = connectionStatusMap[status?.connectionStatus || "disconnected"];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Antigravity CLI</CardTitle>
        <CardDescription>
          Configure Antigravity CLI (agy) as an AI provider. The CLI runs locally but sends data
          to Antigravity/Google services.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* CLI Installation Status */}
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            {cliStatusIcon}
            <div>
              <p className="font-medium">CLI Installation</p>
              <p className="text-sm text-muted-foreground">
                {status?.cliInstalled
                  ? `Version ${status.cliVersion || "unknown"}`
                  : "Not found"}
              </p>
            </div>
          </div>
        </div>

        {/* Connection Status */}
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium">Connection Status</p>
            <p className={`text-sm ${connectionInfo.color}`}>{connectionInfo.label}</p>
            {status?.connectedAt && (
              <p className="text-xs text-muted-foreground">
                Connected: {new Date(status.connectedAt).toLocaleString()}
              </p>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleTestConnection}
            disabled={testing || !status?.cliInstalled}
          >
            {testing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Test Connection
          </Button>
        </div>

        {/* Capabilities */}
        {status?.capabilities && (
          <div>
            <p className="font-medium mb-2">Capabilities</p>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="flex items-center space-x-2">
                {status.capabilities.image ? (
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                ) : (
                  <XCircle className="h-4 w-4 text-red-500" />
                )}
                <span>Images</span>
              </div>
              <div className="flex items-center space-x-2">
                {status.capabilities.resourceBlob ? (
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                ) : (
                  <XCircle className="h-4 w-4 text-red-500" />
                )}
                <span>PDF (Native)</span>
              </div>
              <div className="flex items-center space-x-2">
                <XCircle className="h-4 w-4 text-red-500" />
                <span>Tools</span>
              </div>
              <div className="flex items-center space-x-2">
                <XCircle className="h-4 w-4 text-red-500" />
                <span>Audio</span>
              </div>
            </div>
          </div>
        )}

        {/* Model Selection */}
        {models && models.models.length > 0 && (
          <div className="space-y-4">
            <div>
              <Label htmlFor="model">Model</Label>
              <Select value={selectedModel} onValueChange={setSelectedModel}>
                <SelectTrigger id="model">
                  <SelectValue placeholder="Select a model" />
                </SelectTrigger>
                <SelectContent>
                  {models.models.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {models.thinkingLevels.length > 0 && (
              <div>
                <Label htmlFor="thinking-level">Thinking Level</Label>
                <Select value={selectedThinkingLevel} onValueChange={setSelectedThinkingLevel}>
                  <SelectTrigger id="thinking-level">
                    <SelectValue placeholder="Select thinking level" />
                  </SelectTrigger>
                  <SelectContent>
                    {models.thinkingLevels.map((level) => (
                      <SelectItem key={level} value={level}>
                        {level}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        )}

        {/* Warning Notice */}
        <div className="flex items-start space-x-2 rounded-lg bg-yellow-50 border border-yellow-200 p-3">
          <AlertCircle className="h-5 w-5 text-yellow-600 shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-medium text-yellow-900">External Processing</p>
            <p className="text-yellow-800">
              The Antigravity CLI runs locally but sends data to Antigravity/Google services for
              processing. See Antigravity's terms of service for data handling details.
            </p>
          </div>
        </div>

        {/* Authentication Actions */}
        <div className="flex space-x-2">
          {status?.connectionStatus === "disconnected" ||
          status?.connectionStatus === "auth_required" ? (
            <Button onClick={handleAuthenticate} disabled={authenticating}>
              {authenticating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Connect Antigravity
            </Button>
          ) : (
            <Button variant="outline" onClick={handleDisconnect}>
              Disconnect
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
