/**
 * Base LLM Provider interface
 * All LLM providers must extend this class
 */
class LLMProvider {
  /**
   * Generate a response from the LLM
   * @param {string} prompt - The user prompt
   * @param {Object} options - Additional options (context, temperature, etc.)
   * @returns {Promise<string>} - The generated response
   */
  async generate(prompt, options = {}) {
    throw new Error('Must implement generate() method');
  }

  /**
   * Generate a response with tool calling support
   * @param {string} prompt - The user prompt
   * @param {Array} tools - Available tools
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} - Response with possible tool calls
   */
  async generateWithTools(prompt, tools, options = {}) {
    throw new Error('Must implement generateWithTools() method');
  }

  /**
   * Generate a response from a messages array (for conversation memory)
   * @param {Array<{role: string, content: string}>} messages - Conversation messages
   * @param {Object} options - Additional options (system, temperature, etc.)
   * @returns {Promise<string>} - The generated response
   */
  async generateWithMessages(messages, options = {}) {
    throw new Error('Must implement generateWithMessages() method');
  }

  /**
   * Generate a response with tool support from a messages array.
   * Returns raw provider response for the agent loop to parse.
   * @param {Array} messages - Conversation messages
   * @param {Array} tools - Tool schemas [{name, description, inputSchema}]
   * @param {Object} options - Additional options (system, temperature, etc.)
   * @returns {Promise<Object>} - Raw provider response
   */
  async generateWithToolsAndMessages(messages, tools, options = {}) {
    throw new Error('Must implement generateWithToolsAndMessages() method');
  }

  /**
   * Parse a tool-calling response into a normalized format.
   * @param {Object} response - Raw provider response
   * @returns {{ text: string, toolCalls: Array<{id: string, name: string, input: Object}> }}
   */
  parseToolResponse(response) {
    throw new Error('Must implement parseToolResponse() method');
  }

  /**
   * Format a tool result into a provider-specific message.
   * @param {string} toolCallId - The tool call ID
   * @param {string} result - The tool execution result
   * @returns {Object} - Provider-specific message object
   */
  formatToolResult(toolCallId, result) {
    throw new Error('Must implement formatToolResult() method');
  }

  /**
   * Format the assistant's tool-calling response as a message for the conversation.
   * @param {Object} response - Raw provider response
   * @returns {Object} - Provider-specific assistant message
   */
  formatAssistantMessage(response) {
    throw new Error('Must implement formatAssistantMessage() method');
  }
}

module.exports = { LLMProvider };
