/**
 * @deprecated Edge Runner 已冷冻（frozen）。
 * 此模块保留代码但不再接收新功能或 bug fix。
 * 参见 docs/product-roadmap.md §3 战略决策 S1。
 */
export { runEdgeAgent } from "./actor.js";
export { createSlot, resolveSlot, rejectSlot, clearTaskSlots, getAllSlots, getTaskSlots, addSlotListener, waitForNextSlot, setPendingRecovery } from "./registry.js";
export { createEdgeMcpServer } from "./mcp-server.js";
export { edgeMcpRoute } from "./route.js";
export { buildWrapperRoute } from "./wrapper-api.js";
