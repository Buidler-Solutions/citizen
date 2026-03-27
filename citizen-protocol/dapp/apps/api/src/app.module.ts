import { Module } from "@nestjs/common";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { DatabaseService } from "./db.service";

@Module({
  controllers: [AppController],
  providers: [AppService, DatabaseService]
})
export class AppModule {}
