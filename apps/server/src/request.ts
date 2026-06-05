import { parsePackageId, type PackageId } from '@regesta/protocol'
import * as v from 'valibot'

export const nonEmptyStringSchema = v.pipe(
  v.string(),
  v.nonEmpty('Must be a non-empty string'),
)
const fileFieldSchema = v.instance(File, 'Must be a file')
const textFieldSchema = v.union([v.string(), fileFieldSchema])

export class RequestValidationError extends Error {
  readonly issues: string[]

  constructor(message: string, issues: string[] = []) {
    super(message)
    this.name = 'RequestValidationError'
    this.issues = issues
  }
}

export function requiredParam(value: string | undefined, name: string): string {
  return validateRequest(nonEmptyStringSchema, value, `Missing ${name}`)
}

export async function readBinaryField(
  value: File | string | undefined,
  name: string,
): Promise<Uint8Array> {
  const file = validateRequest(
    fileFieldSchema,
    value,
    `Invalid publish request field ${name}`,
  )

  return new Uint8Array(await file.arrayBuffer())
}

export function readTextField(
  value: File | string | undefined,
  name: string,
): Promise<string> {
  const field = validateRequest(
    textFieldSchema,
    value,
    `Invalid publish request field ${name}`,
  )

  return typeof field === 'string' ? Promise.resolve(field) : field.text()
}

export async function readOptionalTextField(
  value: File | string | undefined,
): Promise<string | undefined> {
  if (value === undefined) {
    return undefined
  }

  const text = await readTextField(value, 'createdAt')
  return text.length === 0 ? undefined : text
}

export async function readJsonBody(body: Promise<unknown>): Promise<unknown> {
  try {
    return await body
  } catch {
    throw new RequestValidationError('Invalid JSON request body')
  }
}

export async function readJsonField<TSchema extends v.GenericSchema>(
  value: File | string | undefined,
  name: string,
  schema: TSchema,
): Promise<v.InferOutput<TSchema>> {
  const text = await readTextField(value, name)
  let json: unknown

  try {
    json = JSON.parse(text)
  } catch {
    throw new RequestValidationError(`Invalid ${name} JSON`)
  }

  return validateRequest(schema, json, `Invalid ${name}`)
}

export function parseRequestPackageId(value: string): PackageId {
  try {
    return parsePackageId(value).id
  } catch (error) {
    throw new RequestValidationError('Invalid package id', [
      error instanceof Error ? error.message : 'Invalid package id',
    ])
  }
}

export function decodeRequestComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new RequestValidationError('Invalid URL encoding')
  }
}

export function validateRequest<TSchema extends v.GenericSchema>(
  schema: TSchema,
  input: unknown,
  message: string,
): v.InferOutput<TSchema> {
  const result = v.safeParse(schema, input)

  if (result.success) {
    return result.output
  }

  throw new RequestValidationError(
    message,
    result.issues.map((issue) => formatIssue(issue)),
  )
}

function formatIssue(issue: v.GenericIssue): string {
  const path = issue.path
    ?.map((item) => String(item.key))
    .filter((key) => key.length > 0)
    .join('.')

  return path ? `${path}: ${issue.message}` : issue.message
}
