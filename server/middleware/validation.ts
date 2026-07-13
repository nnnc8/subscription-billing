import { z } from 'zod';
import { httpError } from './error.js';

export function parseInput<T extends z.ZodType>(
    schema: T,
    input: unknown,
    message = 'Invalid request'
): z.output<T> {
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
        throw httpError(400, message);
    }
    return parsed.data;
}

export const nonEmptyIdSchema = z.string().trim().min(1).max(200);
export const emptyPayloadSchema = z.object({}).passthrough();
