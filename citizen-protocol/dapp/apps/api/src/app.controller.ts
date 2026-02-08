import { Controller, Get } from "@nestjs/common";
import { AppService } from "./app.service";

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get("/health")
  getHealth() {
    return this.appService.getHealth();
  }

  @Get("/capabilities")
  getCapabilities() {
    return this.appService.getCapabilities();
  }

  @Get("/namespaces")
  getNamespaces() {
    return this.appService.getNamespaces();
  }

  @Get("/workflows")
  getWorkflows() {
    return this.appService.getWorkflows();
  }
}
