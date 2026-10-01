import type { Model, StreamEvent } from '@openai/agents'
import { ResponsesStreamAccumulator } from './provider-sse'

/** Preserve the native model and request path; normalize only acknowledged text-only stream completions. */
export function withCompletedResponseMessages(model: Model): Model {
  return {
    getResponse: model.getResponse.bind(model),
    getRetryAdvice: model.getRetryAdvice?.bind(model),
    async *getStreamedResponse(request) {
      const accumulator = new ResponsesStreamAccumulator()
      for await (const event of model.getStreamedResponse(request)) {
        if (event.type === 'model' && event.event && typeof event.event === 'object') accumulator.feed('', event.event as Record<string, unknown>)
        if (event.type === 'response_done' && event.providerData?.type === 'response.completed' && event.response.output.length === 0) {
          const terminal = { ...event.response.providerData, id: event.response.id, output: [] }
          const completed = accumulator.completePayload(terminal)
          if (completed !== terminal) {
            const output = (completed.output as Array<Record<string, unknown>>).map((item) => {
              const { id, content, type: _type, role: _role, status: _status, ...providerData } = item
              return { id, type: 'message', role: 'assistant', status: 'completed', providerData,
                content: (content as Array<Record<string, unknown>>).map(({ type: _partType, text, ...providerData }) => ({ type: 'output_text', text, providerData })) }
            })
            yield { ...event, response: { ...event.response, output } } as StreamEvent
            continue
          }
        }
        yield event
      }
    },
  }
}
