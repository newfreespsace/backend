import { Injectable, NestMiddleware } from "@nestjs/common";

import { Request, Response, NextFunction } from "express";

import { redactRequestBody, redactRequestUrl } from "./common/redact-request-body";

@Injectable()
export class RequestLogMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    console.log("[Request]", {
      method: req.method,
      url: redactRequestUrl(req.originalUrl),
      query: redactRequestBody(req.query),
      body: redactRequestBody(req.body)
    });

    next();
  }
}
