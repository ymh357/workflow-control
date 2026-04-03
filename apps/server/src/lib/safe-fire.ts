import { taskLogger } from "./logger.js";

export function safeFire(promise: Promise<unknown>, taskId: string, message: string): void {
  promise.catch((err) => { taskLogger(taskId).warn({ err }, message); });
}
