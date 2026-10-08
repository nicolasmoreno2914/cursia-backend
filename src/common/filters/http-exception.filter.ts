import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // PayloadTooLargeError from body-parser — must be 413, not 500
    const isPayloadTooLarge =
      exception instanceof Error &&
      ((exception as any).type === 'entity.too.large' ||
        (exception as any).status === 413 ||
        exception.message?.includes('request entity too large'));

    const status = isPayloadTooLarge
      ? HttpStatus.PAYLOAD_TOO_LARGE
      : exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    const message = isPayloadTooLarge
      ? 'El payload es demasiado grande. Reduce el tamaño del contenido enviado.'
      : exception instanceof HttpException
      ? exception.getResponse()
      : 'Internal server error';

    const errorResponse: Record<string, unknown> = {
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      error: typeof message === 'string' ? message : (message as any).message || message,
    };
    // R68 (piloto): datos estructurados del error que el cliente necesita para explicarlo (motivo del bloqueo de generación,
    // críticos de Verificación; Prebrief: qué falta para prepararlo, qué cambió y la huella vigente). Solo estas claves.
    if (message && typeof message === 'object') {
      for (const k of ['code', 'reason', 'criticals', 'pendingChanges', 'blockers', 'diff', 'modelSha256']) {
        if ((message as any)[k] !== undefined) errorResponse[k] = (message as any)[k];
      }
    }

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} → ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json(errorResponse);
  }
}
