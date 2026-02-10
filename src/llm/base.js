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
}

module.exports = { LLMProvider };
