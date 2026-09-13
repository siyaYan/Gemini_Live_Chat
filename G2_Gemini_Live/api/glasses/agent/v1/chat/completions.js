import { handleGeminiChatCompletions } from '../../../../_gemini.js'

export default async function handler(request, response) {
  return handleGeminiChatCompletions(request, response, { endpoint: '/glasses/agent/v1/chat/completions' })
}
