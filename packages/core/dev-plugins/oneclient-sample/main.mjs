// Dev fixture plugin — see ../README.md. Plain ESM, no build step needed.

const sessions = new Map();

export function activate(context) {
  context.logger.info("sample plugin activated");

  context.registerCommand({
    commandId: "sample.sayHello",
    execute(args) {
      return { message: "Hello from the sample plugin!", args };
    },
  });

  context.registerConnectionProvider({
    typeId: "sample",
    configSchema: {
      type: "object",
      properties: {
        label: { type: "string", title: "Label", default: "demo" },
        apiKey: { type: "string", title: "API Key", "x-secret": true },
      },
      required: ["label"],
    },
    async connect(config, ctx) {
      const handle = { id: ctx.connectionId ?? `sample-${Date.now()}`, typeId: "sample", state: { label: config.label } };
      if (ctx.connectionId) sessions.set(ctx.connectionId, handle.state);
      return handle;
    },
    async test(config) {
      if (!config.label) return { success: false, message: "Label is required." };
      return { success: true, message: `Would connect as "${config.label}".` };
    },
    async disconnect(handle, ctx) {
      if (ctx.connectionId) sessions.delete(ctx.connectionId);
    },
  });

  context.registerExplorerProvider({
    nodeTypes: ["sample.item"],
    async getChildren(node, ctx) {
      const session = sessions.get(ctx.connectionId);
      const label = session?.label ?? "demo";
      if (!node) {
        return [{ id: "root", label: `Items (${label})`, nodeType: "sample.item", collapsible: "collapsed" }];
      }
      if (node.id === "root") {
        return [
          { id: "a", label: "Item A", nodeType: "sample.item", collapsible: "none" },
          { id: "b", label: "Item B", nodeType: "sample.item", collapsible: "none" },
        ];
      }
      return [];
    },
  });
}

export function deactivate() {
  sessions.clear();
}
