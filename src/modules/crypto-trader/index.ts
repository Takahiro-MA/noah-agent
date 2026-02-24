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

  constructor(config: TraderConfig) {
    this.config = config;
    this.python = config.pythonCommand ?? "python3";
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
