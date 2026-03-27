import { Body, Controller, Get, Post } from "@nestjs/common";
import { AppService } from "./app.service";

type ChallengeBody = {
  authorWallet: string;
  title: string;
  content: string;
  network?: string;
  creditGrantId: string;
  sponsorBuilderId?: string;
};

type SubmitBody = {
  challengeId: string;
  signature: string;
};

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get("/health")
  getHealth() {
    return this.appService.getHealth();
  }

  @Get("/networks")
  getNetworks() {
    return this.appService.getNetworks();
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

  @Get("/articles")
  getArticles() {
    return this.appService.getArticles();
  }

  @Post("/articles/challenge")
  createChallenge(@Body() body: ChallengeBody) {
    return this.appService.createArticleChallenge(
      body.authorWallet,
      {
        title: body.title,
        content: body.content
      },
      body.network,
      body.creditGrantId,
      body.sponsorBuilderId
    );
  }

  @Post("/articles/submit")
  submitArticle(@Body() body: SubmitBody) {
    return this.appService.submitSignedArticle(body.challengeId, body.signature);
  }
}
