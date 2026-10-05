import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod/v4';
import type { Locale } from '../../../common/i18n/locale';
import type { LlmToolSpec } from '../llm/llm-provider';

/**
 * What a tool knows about who is asking — built by the orchestrator from the
 * SESSION.
 *
 * This is the rule every future personal tool (balances, KYC status, a
 * withdrawal's state) stands on: a tool reads `ctx.clientId` and NEVER an id
 * from its own arguments. The model writes the arguments, and anything the
 * model writes can be steered by text a client typed. An id taken from there
 * would let one client ask about another. `test/assistant.spec.ts` pins it.
 */
export interface AssistantToolContext {
  readonly clientId: number;
  readonly locale: Locale;
}

/**
 * One capability the model may call.
 *
 * `kind: 'read'` tools run when the model asks. `kind: 'action'` tools, which
 * change something, are REFUSED here until the portal can show the client a
 * confirmation card and the client presses it. The model never moves money or
 * changes an account on its own say-so.
 */
export interface AssistantTool<Input = unknown> {
  readonly name: string;
  readonly description: string;
  readonly kind: 'read' | 'action';
  readonly input: z.ZodType<Input>;
  run(ctx: AssistantToolContext, input: Input): Promise<unknown>;
}

/** Every tool module provides its tools under this token (multi-provider style, via a factory). */
export const ASSISTANT_TOOLS = Symbol('ASSISTANT_TOOLS');

/** A tool's answer is cut at this length before it goes back to the model. */
const MAX_TOOL_OUTPUT = 8_000;

@Injectable()
export class ToolRegistry {
  private readonly logger = new Logger(ToolRegistry.name);
  private readonly byName: ReadonlyMap<string, AssistantTool>;

  constructor(@Inject(ASSISTANT_TOOLS) tools: readonly AssistantTool[]) {
    this.byName = new Map(tools.map((tool) => [tool.name, tool]));
  }

  /** The tools offered to the model. v1 offers none. */
  specs(): LlmToolSpec[] {
    return [...this.byName.values()]
      .filter((tool) => tool.kind === 'read')
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: z.toJSONSchema(tool.input),
      }));
  }

  /**
   * Runs one call and returns what goes back to the model, always as text. A
   * failure is reported TO THE MODEL as an error object, so it can tell the
   * client plainly, rather than ending the answer.
   */
  async execute(ctx: AssistantToolContext, name: string, rawArguments: string): Promise<string> {
    const tool = this.byName.get(name);
    if (!tool) return JSON.stringify({ error: `Unknown tool: ${name}` });
    if (tool.kind !== 'read') {
      return JSON.stringify({ error: 'This action needs the client to confirm it in the portal.' });
    }

    let parsed: unknown;
    try {
      parsed = rawArguments.trim() === '' ? {} : JSON.parse(rawArguments);
    } catch {
      return JSON.stringify({ error: 'The arguments were not valid JSON.' });
    }
    const input = tool.input.safeParse(parsed);
    if (!input.success) {
      return JSON.stringify({ error: 'The arguments did not match the tool.' });
    }

    try {
      const output = JSON.stringify(await tool.run(ctx, input.data));
      return output.length > MAX_TOOL_OUTPUT ? output.slice(0, MAX_TOOL_OUTPUT) : output;
    } catch (error) {
      this.logger.error(
        `Assistant tool ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return JSON.stringify({ error: 'That information is not available right now.' });
    }
  }
}
