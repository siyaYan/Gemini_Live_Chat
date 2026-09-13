import { modelsResponse, sendJson, setCorsHeaders } from '../../../_gemini.js'

export default async function handler(request, response) {
  setCorsHeaders(response, 'GET, OPTIONS', 'Accept, Content-Type, Authorization, X-API-Key, X-Even-AI-Agent-Token')

  if (request.method === 'OPTIONS') {
    response.status(204).end()
    return
  }

  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'method_not_allowed' })
    return
  }

  sendJson(response, 200, modelsResponse())
}
