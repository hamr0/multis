/**
 * Tool adapter — converts multis tool format to bareagent tool format.
 * Wraps execute with ctx closure and audit logging.
 */

const { logAudit } = require('../governance/audit');

/**
 * Adapt multis tools to bareagent format.
 * bareagent expects: { name, description, parameters, execute(args) }
 * multis has: { name, description, input_schema, execute(input, ctx) }
 *
 * @param {Array} tools — multis tool definitions
 * @param {Object} ctx — execution context { senderId, chatId, isOwner, runtimePlatform, indexer, memoryManager, platform }
 * @returns {Array} — bareagent-compatible tools
 */
function adaptTools(tools, ctx) {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
    execute: async (args) => {
      try {
        const result = await tool.execute(args || {}, ctx);
        logAudit({
          action: 'tool_call',
          tool: tool.name,
          input: args,
          user_id: ctx.senderId,
          chatId: ctx.chatId,
          status: 'success'
        });
        return result || '(no output)';
      } catch (err) {
        logAudit({
          action: 'tool_call',
          tool: tool.name,
          input: args,
          user_id: ctx.senderId,
          chatId: ctx.chatId,
          status: 'error',
          error: err.message
        });
        return `Error: ${err.message}`;
      }
    }
  }));
}

module.exports = { adaptTools };
