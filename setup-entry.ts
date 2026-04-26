import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { telnyxSmsPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(telnyxSmsPlugin);
