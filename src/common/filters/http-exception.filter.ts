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

    const errorResponse = {
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      error: typeof message === 'string' ? message : (message as any).message || message,
    };

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} → ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json(errorResponse);
  }
}
