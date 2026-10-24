import type { JsonSchemaObject, UiSchema } from "@oneclient/plugin-api";

export interface ConnectionProviderInfo {
  pluginId: string;
  typeId: string;
  configSchema: JsonSchemaObject;
  uiSchema?: UiSchema;
}

/**
 * Tracks which plugin actually registered what, at runtime — as opposed
 * to `ContributionRegistry`, which only reflects what a manifest *declares*.
 * A connection type can be declared in `contributes.connectionTypes`
 * before the owning plugin has ever activated; this directory only has an
 * entry once `registerConnectionProvider`/etc. has actually run inside the
 * extension host, which is what callers that need the live
 * `configSchema`/routing info (connection manager, command execution) use.
 */
export class ProviderDirectory {
  private readonly connectionProviders = new Map<string, ConnectionProviderInfo>();
  private readonly explorerNodeOwners = new Map<string, string>();
  private readonly commandOwners = new Map<string, string>();

  registerConnection(info: ConnectionProviderInfo): void {
    this.connectionProviders.set(info.typeId, info);
  }

  registerExplorer(pluginId: string, nodeTypes: string[]): void {
    for (const nodeType of nodeTypes) this.explorerNodeOwners.set(nodeType, pluginId);
  }

  registerCommand(pluginId: string, commandId: string): void {
    this.commandOwners.set(commandId, pluginId);
  }

  /** Called when a plugin deactivates or crashes — its runtime registrations are no longer valid. */
  removeForPlugin(pluginId: string): void {
    for (const [typeId, info] of this.connectionProviders) {
      if (info.pluginId === pluginId) this.connectionProviders.delete(typeId);
    }
    for (const [nodeType, owner] of this.explorerNodeOwners) {
      if (owner === pluginId) this.explorerNodeOwners.delete(nodeType);
    }
    for (const [commandId, owner] of this.commandOwners) {
      if (owner === pluginId) this.commandOwners.delete(commandId);
    }
  }

  getConnectionInfo(typeId: string): ConnectionProviderInfo | undefined {
    return this.connectionProviders.get(typeId);
  }

  getExplorerOwner(nodeType: string): string | undefined {
    return this.explorerNodeOwners.get(nodeType);
  }

  getCommandOwner(commandId: string): string | undefined {
    return this.commandOwners.get(commandId);
  }
}
