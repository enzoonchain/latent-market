/**
 * `/ads` — handled by the plugin directly (bypasses the LLM).
 *
 *   /ads settings   wallet, frequency, server, paused state
 *   /ads balance    balance & cash-out live on the dashboard (signed wallet)
 *   /ads off | on   pause / resume the footer for this gateway (owner only)
 */
import type { OpenClawPluginApi, PluginCommandContext, PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginConfig } from "../lib/config.js";
import type { AdsState } from "../hooks/reply-footer.js";
export declare const DASHBOARD_URL = "https://www.latentprotocol.xyz/dashboard";
export declare function handleAdsCommand(ctx: PluginCommandContext, config: PluginConfig, state: AdsState): PluginCommandResult;
export declare function registerAdsCommand(api: OpenClawPluginApi, config: PluginConfig, state: AdsState): void;
