/**
 * Crypto Trader Module
 *
 * Bridges to the GMO trading bot (Python) via script-runner.
 * The Python bot is located at salvaged/gmo-trading/ and runs independently.
 *
 * This module provides:
 * - Start/stop paper trader
 * - Check trader status and logs
 * - Execute one-shot trades via Claude analysis
 */

import fs from "node:fs";
import path from "node:path";
import { runScript, type ScriptResult } from "../../runners/script-runner.js";

export type TraderConfig = {
  /** Path to the GMO trading bot directory */
  botDir: string;
  /** Python command (default: python3) */
  pythonCommand?: string;
};

export type TraderStatus = {
  running: boolean;
  lastLog?: string;
  error?: string;
};

export class CryptoTrader {
  private readonly config: TraderConfig;
  private readonly python: string;
  private readonly activeMarker: string;

  constructor(config: TraderConfig) {
    this.config = config;
    this.python = config.pythonCommand ?? "python3";
    this.activeMarker = path.join(config.botDir, "logs", ".trader_active");
  }

  /**
   * Start continuous paper trading and enable heartbeat monitoring.
   * Creates .trader_active marker so the heartbeat job knows to monitor.
   */
  async start(): Promise<ScriptResult> {
    fs.mkdirSync(path.dirname(this.activeMarker), { recursive: true });
    fs.writeFileSync(this.activeMarker, new Date().toISOString());
    console.log("[crypto-trader] Started — heartbeat monitoring enabled");
    return this.runCycle();
  }

  /**
   * Stop paper trading and disable heartbeat monitoring.
   * Removes .trader_active marker so the heartbeat job skips checks.
   */
  stop(): void {
    try {
      fs.unlinkSync(this.activeMarker);
    } catch {
      // already removed
    }
    console.log("[crypto-trader] Stopped — heartbeat monitoring disabled");
  }

  /**
   * Check if paper trader is marked as active.
   */
  isActive(): boolean {
    return fs.existsSync(this.activeMarker);
  }

  /**
   * Run the paper trader for a single cycle.
   */
  async runCycle(): Promise<ScriptResult> {
    return runScript({
      command: this.python,
      args: ["-m", "src.paper_trader", "--once"],
      cwd: this.config.botDir,
      timeoutMs: 120_000,
    });
  }

  /**
   * Get current market indicators.
   */
  async getIndicators(pair?: string): Promise<ScriptResult> {
    return runScript({
      command: this.python,
      args: ["-m", "src.indicators", "--pair", pair ?? "BTC_JPY", "--json"],
      cwd: this.config.botDir,
      timeoutMs: 30_000,
    });
  }

  /**
   * Run backtest with given parameters.
   */
  async runBacktest(args: string[]): Promise<ScriptResult> {
    return runScript({
      command: this.python,
      args: ["-m", "backtest.engine", ...args],
      cwd: this.config.botDir,
      timeoutMs: 300_000,
    });
  }

  /**
   * Check if the trading bot is healthy by reading recent logs.
   */
  async getStatus(): Promise<TraderStatus> {
    try {
      const result = await runScript({
        command: "tail",
        args: ["-n", "5", "logs/paper_trader.log"],
        cwd: this.config.botDir,
        timeoutMs: 5_000,
      });

      return {
        running: result.exitCode === 0,
        lastLog: result.stdout.trim() || undefined,
      };
    } catch (err) {
      return {
        running: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
