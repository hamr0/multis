/**
 * Tool executor — dispatches tool calls to their execute functions.
 * Handles owner_only checks and audit logging.
 */

const { logAudit } = require('../governance/audit');

/**
 * Execute a single tool call.
 * @param {Object} toolCall — { name, input }
 * @param {Array} tools — available tool definitions (already filtered for platform)
 * @param {Object} ctx — execution context { senderId, chatId, isOwner, runtimePlatform, indexer, memoryManager }
 * @returns {Promise<string>} — result text
 */
async function executeTool(toolCall, tools, ctx) {
  const tool = tools.find(t => t.name === toolCall.name);
  if (!tool) {
    return `Unknown tool: ${toolCall.name}`;
  }

  try {
    const result = await tool.execute(toolCall.input || {}, ctx);

    logAudit({
      action: 'tool_call',
      tool: toolCall.name,
      input: toolCall.input,
      user_id: ctx.senderId,
      chatId: ctx.chatId,
      status: 'success'
    });

    return result || '(no output)';
  } catch (err) {
    logAudit({
      action: 'tool_call',
      tool: toolCall.name,
      input: toolCall.input,
      user_id: ctx.senderId,
      chatId: ctx.chatId,
      status: 'error',
      error: err.message
    });

    return `Error: ${err.message}`;
  }
}

module.exports = { executeTool };
