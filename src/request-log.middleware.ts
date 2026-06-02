import { Injectable, NestMiddleware } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";

@Injectable()
export class RequestLogMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    console.log("[Request]", {
      method: req.method,
      url: req.originalUrl,
      query: req.query,
      body: req.body
    });

    next();
  }
}
