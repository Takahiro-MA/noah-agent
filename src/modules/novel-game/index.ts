/**
 * Novel Game Module (stub)
 *
 * Self-running novel game creation system.
 * Uses Claude to generate story, choices, and game logic.
 *
 * TODO:
 * - Story generation engine
 * - Choice tree management
 * - Asset generation (text, possibly images)
 * - Game state persistence
 * - Web-based player interface
 */

export type NovelGameConfig = {
  outputDir: string;
};

export class NovelGame {
  private readonly config: NovelGameConfig;

  constructor(config: NovelGameConfig) {
    this.config = config;
  }

  async generateChapter(_prompt: string): Promise<{ ok: boolean; message: string }> {
    return { ok: false, message: "Not implemented yet" };
  }
}
