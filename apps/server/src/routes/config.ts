import { Hono } from "hono";
import { configSettingsRoute } from "./config-settings.js";
import { configPipelinesRoute } from "./config-pipelines.js";
import { configPromptsRoute } from "./config-prompts.js";
import { configFilesRoute } from "./config-files.js";

export const configRoute = new Hono();
configRoute.route("", configSettingsRoute);
configRoute.route("", configPipelinesRoute);
configRoute.route("", configPromptsRoute);
configRoute.route("", configFilesRoute);
