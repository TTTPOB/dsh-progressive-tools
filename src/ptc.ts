/** PTC executor with host-configured progressive SDK presentation. @module */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { PtcExecutor, Config as PtcConfig } from '@deepseek-ai/dsh-tool-executor-ptc'
import { ProgressiveExecutor } from './index.ts'

/** PTC limits and optional native exceptions supplied by the DSH fork. */
export type Config = Partial<PtcConfig> & { ptcNativeTools?: string[] }
export const Config: z<Config> = z.intersect([PtcConfig, z.object({ ptcNativeTools: z.array(z.string()).default([]) })])

/** Preserve all executor-owned wire declarations, including fork-native exceptions. */
export class ProgressivePtcExecutor extends ProgressiveExecutor {
  constructor(ctx: Context, config: Config = {}, maxParallel?: () => number) {
    super(ctx, new PtcExecutor(ctx, config, maxParallel), 'ptc')
  }
}

export const name = 'progressive-ptc-executor'
export const inject = ['tools', 'systemPrompt', 'ptcRuntime', 'progressiveTools']

/** Select this executor instead of the upstream PTC executor in the same scope. */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.setExecutor(new ProgressivePtcExecutor(ctx, config))
}
