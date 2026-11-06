/** Native executor with host-configured progressive presentation. @module */
import type { Context } from '@deepseek-ai/cordis'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import { ProgressiveExecutor } from './index.ts'

/** Native batch execution with a compact, stable declaration prefix. */
export class ProgressiveNativeExecutor extends ProgressiveExecutor {
  constructor(ctx: Context, maxParallel?: () => number) {
    super(ctx, new NativeToolExecutor(ctx, maxParallel), 'native')
  }
}

export const name = 'progressive-native-executor'
export const inject = ['tools', 'systemPrompt', 'progressiveTools']

/** Select this executor instead of the upstream native executor in the same scope. */
export function apply(ctx: Context): void {
  ctx.tools.setExecutor(new ProgressiveNativeExecutor(ctx))
}
