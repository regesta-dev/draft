import { requestIdHeader, validatedRequestId } from '../request.ts'
import { errorResponse, jsonResponse } from '../responses.ts'
import type { Context } from 'hono'

export interface KnownTransportError {
  code: string
  match: (error: Error) => boolean
  message?: string
  status: 400 | 401 | 403 | 404 | 409 | 422
}

export type TransportErrorBoundary = (
  error: Error,
  context: Context,
) => Response | Promise<Response>

export function createTransportErrorBoundary(
  knownErrors: KnownTransportError[] = [],
): TransportErrorBoundary {
  return (error, context) => {
    const knownError = knownErrors.find((item) => item.match(error))

    if (knownError) {
      const message = knownError.message ?? error.message

      return jsonResponse(
        context.req.method,
        errorResponse(knownError.code, message, errorIssues(error)),
        { status: knownError.status },
      )
    }

    const id = requestId(context)

    console.error('Unexpected transport error', {
      error,
      kind: 'regesta.unexpected-error',
      ...(id ? { requestId: id } : {}),
    })

    return jsonResponse(
      context.req.method,
      errorResponse('internal_server_error', 'Internal Server Error'),
      { status: 500 },
    )
  }
}

function errorIssues(error: Error): string[] {
  if (!('issues' in error)) {
    return []
  }

  const issues = error.issues

  return Array.isArray(issues) &&
    issues.every((item) => typeof item === 'string')
    ? issues
    : []
}

function requestId(context: Context): string | undefined {
  return validatedRequestId(
    context.res.headers,
    context.req.header(requestIdHeader),
  )
}
