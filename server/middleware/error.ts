import type { ErrorRequestHandler } from 'express';

export type HttpError = Error & { status?: number; statusCode?: number };

export function httpError(status: number, message: string): HttpError {
    return Object.assign(new Error(message), { status });
}

export const errorHandler: ErrorRequestHandler = (error: HttpError, _req, res, _next) => {
    const candidate = error.status ?? error.statusCode;
    const status = Number.isInteger(candidate) && candidate! >= 400 && candidate! < 600
        ? candidate!
        : 500;

    if (status >= 500) {
        console.error('Request failed:', error);
    }

    res.status(status).json({
        error: status >= 500 ? 'Internal server error' : error.message || 'Bad request'
    });
};
